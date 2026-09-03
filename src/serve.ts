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
import { Tailer, type Agent } from "./tail.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository to draw: the first argument, or SKY_REPO, or where you ran it. It must hold a sky.yaml. */
const ROOT = resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? process.env.SKY_REPO ?? process.cwd());
const PORT = Number(process.env.SKY_PORT ?? 4340);
if (!existsSync(join(ROOT, "sky.yaml"))) {
  process.stderr.write(`no sky.yaml in ${ROOT}\n\n  skylight <path-to-repo>\n\nA sky.yaml names the north stars and which files belong to which area. See README.\n`);
  process.exit(1);
}

let sky: Sky = readSky(ROOT);
let agents: Agent[] = [];
const clients = new Set<import("node:http").ServerResponse>();
const payload = () => JSON.stringify({ sky, agents, at: Date.now(), root: ROOT, file: join(ROOT, "sky.yaml") });
const push = () => { const data = `event: sky\ndata: ${payload()}\n\n`; for (const c of clients) c.write(data); };

const tailer = new Tailer(ROOT, () => { agents = tailer.list(); push(); });

const exportAt = process.argv.indexOf("--export");
if (exportAt > 0) {
  tailer.poll(); agents = tailer.list();
  const html = readFileSync(join(HERE, "index.html"), "utf8")
    .replace("<script>", `<script>window.__SKY__=${payload()};</script>\n<script>`);
  writeFileSync(process.argv[exportAt + 1], html);
  process.stdout.write(`wrote ${process.argv[exportAt + 1]} · ${sky.stars.reduce((n, s) => n + s.areas.length, 0)} areas · ${agents.length} agents\n`);
  process.exit(0);
}

// re-derive the sky when the repo changes, debounced — git and globs are cheap
let timer: NodeJS.Timeout | null = null;
const rederive = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { sky = readSky(ROOT); push(); }, 800); };
for (const d of ["src", "test", "sky.yaml", ".git/refs/heads"]) {
  try { watch(join(ROOT, d), { recursive: true }, rederive); } catch {}
}

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
      open.set(idx, { text: String(textOld), answer: text, when: new Date().toISOString(), by: "person" });
      writeFileSync(file, doc.toString()); return null;
    }
  return `no area called ${area}`;
}

const server = createServer((req, res) => {
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
    const r = gather(ROOT); sky = readSky(ROOT); push();
    res.writeHead(r.error ? 400 : 200, { "content-type": "application/json" }); return res.end(JSON.stringify(r));
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
  tailer.poll(); agents = tailer.list();
  setInterval(() => tailer.poll(), 1500);
  process.stdout.write(`skylight  http://127.0.0.1:${PORT}\n  repo    ${ROOT}\n  areas   ${sky.stars.reduce((n, s) => n + s.areas.length, 0)}\n  agents  ${agents.length} (${agents.filter((a) => a.state === "active").length} active)\n`);
});
