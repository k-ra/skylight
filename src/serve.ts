/**
 * Serves the sky. One process: reads the repo, tails the transcripts, and
 * pushes changes to the page over SSE. `--export <file>` writes a standalone
 * page with the current data inlined — the sky as of now — for sharing.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, YAMLSeq } from "yaml";
import { readSky, type Sky } from "./read.ts";
import { gather, decide } from "./gather.ts";
import { orchestrate } from "./orchestrate.ts";
import { gate, shareToken } from "./access.ts";
import { Tailer, type Agent } from "./tail.ts";
import { CodexTailer } from "./codex-tail.ts";
import { modelProvider } from "./model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository to draw: the first argument, or SKY_REPO, or where you ran it. It must hold a sky.yaml. */
const ROOT = resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? process.env.SKY_REPO ?? process.cwd());
const PORT = Number(process.env.SKY_PORT ?? 4340);
if (!existsSync(join(ROOT, "sky.yaml"))) {
  process.stderr.write(`no sky.yaml in ${ROOT}\n\n  skylight <path-to-repo>\n\nA sky.yaml names the north stars and which files belong to which area. See README.\n`);
  process.exit(1);
}

const PROVIDER = modelProvider();
let modelBusy = false;
let sky: Sky = readSky(ROOT);
let agents: Agent[] = [];
const clients = new Set<import("node:http").ServerResponse>();
const payload = () => JSON.stringify({ sky, agents: agents.map(a => ({...a, intent: sky.activity?.labels[a.id] ?? (a.provider === "reported" ? a.intent : null)})), at: Date.now(), root: ROOT, file: join(ROOT, "sky.yaml"), modelProvider: PROVIDER });
const push = () => { const data = `event: sky\ndata: ${payload()}\n\n`; for (const c of clients) c.write(data); };

/**
 * Presence, reported. The tailer finds Claude Code sessions on its own; any
 * other orchestrator can put its agents on the sky by posting here:
 *   POST /api/presence  { id, intent?, file?, state?: "active"|"idle"|"gone",
 *                         phase?: "working"|"waiting"|"done"|"failed", note?, task? }
 * A report is good for ten minutes, then the ship goes idle; a day, then gone.
 * `phase: waiting` with a `note` is how a ship asks the person something — it
 * shows up in HQ as waiting on you. `done` and `failed` end the ship's work.
 */
const reported = new Map<string, Agent>();
function presence(b: any): string | null {
  const id = String(b?.id ?? "").trim(); if (!id) return "an agent needs an id";
  if (b.state === "gone") { reported.delete(id); return null; }
  const prev = reported.get(id);
  const file = typeof b.file === "string" ? b.file.replace(/^\/+/, "") : prev?.lastFile ?? null;
  const phase = ["working", "waiting", "done", "failed"].includes(b.phase) ? b.phase as Agent["phase"] : prev?.phase;
  const note = typeof b.note === "string" ? b.note.replace(/\s+/g, " ").trim().slice(0, 160) : prev?.note ?? null;
  const a: Agent = { provider: "reported", id, short: id.slice(0, 8), cwd: ROOT, subagent: !!b.subagent, intent: typeof b.intent === "string" ? b.intent.slice(0, 160) : prev?.intent ?? null,
    lastAt: Date.now(), lastFile: file, lastTool: typeof b.tool === "string" ? b.tool : "reported", touched: [...(prev?.touched ?? []), ...(file ? [{ file, at: Date.now(), tool: "reported" }] : [])].slice(-400),
    tools: prev?.tools ?? {}, state: b.state === "idle" || phase === "done" || phase === "failed" ? "idle" : "active",
    phase, note, noteAt: typeof b.note === "string" ? Date.now() : prev?.noteAt, task: typeof b.task === "string" ? b.task.slice(0, 80) : prev?.task ?? null };
  reported.set(id, a); return null;
}
const allAgents = (): Agent[] => {
  const now = Date.now();
  for (const a of reported.values()) a.state = now - a.lastAt < 10 * 60_000 ? (a.state === "idle" ? "idle" : "active") : now - a.lastAt < 24 * 3600_000 ? "idle" : "gone";
  for (const [id, a] of reported) if (a.state === "gone") reported.delete(id);
  const seen = new Set(reported.keys());
  return [...reported.values(), ...[...(tailer?.list() ?? []), ...(codexTailer?.list() ?? [])].filter((a) => !seen.has(a.id))].sort((x, y) => y.lastAt - x.lastAt);
};
const sources = (process.env.SKY_AGENT_SOURCES ?? "claude,codex").split(",").map(s => s.trim());
const changed = () => { agents = allAgents(); push(); };
const tailer = sources.includes("claude") ? new Tailer(ROOT, changed) : null;
const codexTailer = sources.includes("codex") ? new CodexTailer(ROOT, changed, { worktrees: sky.worktrees.map(w => w.path), excludePaths: sky.activity?.excludePaths }) : null;
const pollAgents = () => { tailer?.poll(); codexTailer?.poll(); agents = allAgents(); };

const exportAt = process.argv.indexOf("--export");
if (exportAt > 0) {
  pollAgents();
  const html = readFileSync(join(HERE, "index.html"), "utf8")
    .replace("<script>", `<script>window.__SKY__=${payload()};</script>\n<script>`);
  writeFileSync(process.argv[exportAt + 1], html);
  process.stdout.write(`wrote ${process.argv[exportAt + 1]} · ${sky.stars.reduce((n, s) => n + s.areas.length, 0)} areas · ${agents.length} agents\n`);
  process.exit(0);
}

// Watch the mapped source trees as well as the manifest. Monorepos need apps/,
// packages/, skills/, etc., not only a hard-coded src/ directory.
let timer: NodeJS.Timeout | null = null;
const watched = new Map<string, ReturnType<typeof watch>>();
const refreshWatches = () => {
  const paths = new Set(["sky.yaml", ".git/refs/heads", ...sky.stars.flatMap(s => s.areas.flatMap(a => a.paths.map(p => p.split("/")[0])))]);
  for (const [path, watcher] of watched) if (!paths.has(path)) { watcher.close(); watched.delete(path); }
  for (const path of paths) {
    if (watched.has(path)) continue;
    try { watched.set(path, watch(join(ROOT, path), { recursive: true }, rederive)); } catch {}
  }
};
const rederive = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => {
  try { sky = readSky(ROOT); refreshWatches(); push(); }
  catch { process.stderr.write("Could not read sky.yaml; keeping the last valid map.\n"); }
}, 800); };
refreshWatches();

/**
 * Place a star. The only write the page ever does: one line into sky.yaml,
 * under an area's list or the loose ideas. The document is edited in place
 * so the comments a person wrote stay where they were.
 */
function place(kind: string, area: string | null, text: string, at: [number, number] | null): string | null {
  const node: any = { text, when: new Date().toISOString(), by: "person" };
  if (at) node.at = [Number(at[0].toFixed(3)), Number(at[1].toFixed(3))];
  const file = join(ROOT, "sky.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  const seqAt = (map: any, key: string): YAMLSeq => {
    let seq = map.get(key, true); if (!seq) { seq = new YAMLSeq(); map.set(key, seq); } return seq;
  };
  if (kind === "idea") { seqAt(doc as any, "ideas").add(at ? node : text); }
  else {
    if (!["done", "todo", "open", "explore"].includes(kind)) return "unknown kind";
    let found: any = null;
    for (const star of (doc.get("stars", true) as YAMLSeq).items as any[])
      for (const a of (star.get("areas", true) as YAMLSeq).items as any[]) if (a.get("name") === area) found = a;
    if (!found) return `no area called ${area}`;
    seqAt(found, kind).add(node);
  }
  writeFileSync(file, doc.toString());
  return null;
}

/** Light a star: the one list only a person may touch. */
function light(area: string): string | null {
  const file = join(ROOT, "sky.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  const live = doc.get("live", true) as YAMLSeq | undefined;
  if (live && (live.items as any[]).some((i) => String(i?.value ?? i) === area)) return `${area} is already live`;
  if (!live) doc.set("live", [area]); else live.add(area);
  writeFileSync(file, doc.toString()); return null;
}
/** Answer a question: the open entry keeps its text and gains the answer, when, by. */
function answer(area: string, question: string, text: string): string | null {
  if (!text) return "say the answer";
  const file = join(ROOT, "sky.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  for (const star of (doc.get("stars", true) as YAMLSeq).items as any[])
    for (const a of (star.get("areas", true) as YAMLSeq).items as any[]) {
      if (a.get("name") !== area) continue;
      const open = a.get("open", true) as YAMLSeq | undefined; if (!open) return "no questions here";
      const idx = (open.items as any[]).findIndex((i) => { const v = i?.get ? i.get("text") : (i?.value ?? i); return String(v).split(" | ")[0].trim() === question; });
      if (idx < 0) return "no such question";
      const old = (open.items as any[])[idx]; const textOld = old?.get ? old.get("text") : (old?.value ?? old);
      // Keep where the star was placed. Drop the orchestrator's reading of the PREVIOUS
      // answer so it reconsiders this one — a stale proposal is worse than no proposal.
      const at = old?.get ? old.get("at", true) : undefined;
      open.set(idx, { text: String(textOld), answer: text, when: new Date().toISOString(), by: "person" });
      const fresh = (open.items as any[])[idx];
      if (at !== undefined && at !== null && fresh?.set) fresh.set("at", at);
      writeFileSync(file, doc.toString()); return null;
    }
  return `no area called ${area}`;
}

/** Append strings to a dotted path inside an area, creating maps and the list as needed. */
function appendAt(area: any, path: string, values: string[]): void {
  const keys = path.split(".").filter(Boolean);
  const last = keys.pop(); if (!last) return;
  let node = area;
  for (const k of keys) {
    let next = node.get(k, true);
    if (!next?.set) { node.set(k, {}); next = node.get(k, true); }
    node = next;
  }
  const list = node.get(last, true) as YAMLSeq | undefined;
  if (!list?.add) node.set(last, values);
  else for (const v of values) if (!(list.items as any[]).some((i) => String(i?.value ?? i) === v)) list.add(v);
}

/**
 * Reconcile an answered question. Answering is not settling: the orchestrator reads
 * the answer and proposes what it changes, and only a person accepts that. Accepting
 * writes the proposed lines into the project's own vocabulary and stamps `reconciled`,
 * which is what finally closes the question. Rejecting drops the proposals and leaves
 * the question open, without inviting the orchestrator to propose the same thing again.
 *
 * WHERE an accepted line goes is the project's business, not Skylight's. A project
 * says so with `accept_into:` on the area or at the top of sky.yaml — Facet points it
 * at `spec.acceptance`; another project might not have a spec block at all. Absent
 * configuration, an area that already keeps a `spec` map gets `spec.acceptance`, and
 * anything else gets `accepted:`, which needs no project schema. The path is never
 * taken from the model — an agent must not get to choose where it writes.
 */
function reconcile(area: string, question: string, action: "accept" | "reject"): string | null {
  const file = join(ROOT, "sky.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  for (const star of (doc.get("stars", true) as YAMLSeq).items as any[])
    for (const a of (star.get("areas", true) as YAMLSeq).items as any[]) {
      if (a.get("name") !== area) continue;
      const open = a.get("open", true) as YAMLSeq | undefined; if (!open) return "no questions here";
      const item = (open.items as any[]).find((i) => { const v = i?.get ? i.get("text") : (i?.value ?? i); return String(v).split(" | ")[0].trim() === question; });
      if (!item?.get) return "no such question";
      if (!item.get("answer")) return "that question has no answer yet";
      if (item.get("reconciled")) return "already reconciled";
      const now = new Date().toISOString();
      const proposes = item.get("proposes", true) as YAMLSeq | undefined;

      if (action === "reject") {
        if (!proposes) return "nothing proposed to reject";
        item.delete("proposes");
        item.set("proposes_rejected", now);
        writeFileSync(file, doc.toString()); return null;
      }

      const clauses = ((proposes?.items ?? []) as any[])
        .map((p) => String(p?.get?.("text") ?? "").trim()).filter(Boolean);
      if (clauses.length) {
        const configured = String(a.get("accept_into") ?? doc.get("accept_into") ?? "").trim();
        const dest = configured || ((a.get("spec", true) as any)?.set ? "spec.acceptance" : "accepted");
        if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(dest)) return `accept_into is not a valid path: ${dest}`;
        appendAt(a, dest, clauses);
      }
      item.set("reconciled", now);
      item.set("reconciled_by", "person");
      writeFileSync(file, doc.toString()); return null;
    }
  return `no area called ${area}`;
}

const server = createServer(async (req, res) => {
  if (gate(req, res)) return;          // loopback is open; anywhere else needs the share key
  const url = req.url ?? "/";
  if (url === "/api/place" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      try {
        const { kind, area, text, at } = JSON.parse(body);
        if (typeof text !== "string" || !text.trim()) throw new Error("say what the star is");
        const err = place(String(kind), area ?? null, text.trim(), Array.isArray(at) && at.length === 2 ? [Number(at[0]), Number(at[1])] : null);
        if (err) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: err })); }
        sky = readSky(ROOT); push();
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: (e as Error).message })); }
    }); return;
  }
  if (url === "/api/gather" && req.method === "POST") {
    // slow — a model call — so answer when it is done and push to everyone
    if (modelBusy) { res.writeHead(409, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "A planning request is already running." })); }
    modelBusy = true;
    try {
      const r = await gather(ROOT); sky = readSky(ROOT); push();
      res.writeHead(r.error ? 400 : 200, { "content-type": "application/json" }); return res.end(JSON.stringify(r));
    } catch { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Could not gather ideas. Check sky.yaml and the server log." })); }
    finally { modelBusy = false; }
  }
  if (url === "/api/presence" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      try { const err = presence(JSON.parse(body)); if (err) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: err })); }
        agents = allAgents(); push(); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, agents: agents.length })); }
      catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: (e as Error).message })); }
    }); return;
  }
  if ((url === "/api/light" || url === "/api/answer") && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      try {
        const b = JSON.parse(body);
        const err = url === "/api/light" ? light(String(b.area)) : answer(String(b.area), String(b.question), String(b.text ?? "").trim());
        if (err) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: err })); }
        sky = readSky(ROOT); push();
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: (e as Error).message })); }
    }); return;
  }
  if (url === "/api/reconcile" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      try {
        const b = JSON.parse(body);
        const err = reconcile(String(b.area), String(b.question), b.action === "reject" ? "reject" : "accept");
        if (err) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: err })); }
        sky = readSky(ROOT); push();
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: (e as Error).message })); }
    }); return;
  }
  if (url === "/api/proposal" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      try {
        const { name, action } = JSON.parse(body);
        const err = decide(ROOT, String(name), action === "accept" ? "accept" : "veto");
        if (err) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: err })); }
        sky = readSky(ROOT); push();
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: (e as Error).message })); }
    }); return;
  }
  if (url === "/api/sky") { res.writeHead(200, { "content-type": "application/json" }); return res.end(payload()); }
  if (url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: sky\ndata: ${payload()}\n\n`);
    clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(join(HERE, "index.html")));
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  pollAgents();
  setInterval(() => { pollAgents(); }, 1500);
  // the orchestrator: reaches for stars a person placed. Set SKY_NO_ORCHESTRATOR to
  // 1/true/yes/on to run without it. "0", "false", "no" and empty all leave it ON,
  // so the obvious way to switch it back on actually works.
  const orchestratorOff = /^(1|true|yes|on)$/i.test((process.env.SKY_NO_ORCHESTRATOR ?? "").trim());
  if (!orchestratorOff) {
    setInterval(async () => {
      if (modelBusy) return; modelBusy = true;
      try { const r = await orchestrate(ROOT, 2); if (r.error) process.stderr.write(`orchestrator: ${r.error}\n`);
        if (r.reached.length) { for (const x of r.reached) process.stdout.write(`reached · ${x}\n`); sky = readSky(ROOT); push(); } }
      catch { process.stderr.write("orchestrator: could not process sky.yaml\n"); }
      finally { modelBusy = false; }
    }, 6000);
  }
  process.stdout.write(`skylight  http://127.0.0.1:${PORT}\n  repo    ${ROOT}\n  access  ${shareToken() ? "shared — a key is required from anywhere but this machine" : "this machine only"}\n  orchestrator  ${orchestratorOff ? "off" : "watching sky.yaml"}\n  model   ${PROVIDER}\n  activity  ${sources.join(", ")}\n  areas   ${sky.stars.reduce((n, s) => n + s.areas.length, 0)}\n  agents  ${agents.length} (${agents.filter((a) => a.state === "active").length} active)\n`);
});
