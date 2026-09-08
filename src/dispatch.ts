/**
 * Dispatch: a person sends a ship to a star.
 *
 * The star is a to-do, a question, or an exploration in sky.yaml. Sending a
 * ship means: make a git worktree on a branch named after the star, run Claude
 * Code there in print mode with the star as its task, and watch its stream so
 * the ship on the sky says what it is doing. When it is done it leaves a
 * postcard — did / doubted / untouched — and its branch waits for the person.
 *
 * Accepting merges the branch and moves the star to `done` with `landed` and
 * `proof`. Revising sends the same ship back with a note, resuming its session
 * on the same branch. Recalling stops it. Nothing here is automatic: a person
 * sends, a person accepts. The record lives on the star itself:
 *
 *   run:
 *     id: ship-…        branch: sky/…       status: running | done | failed | recalled | accepted
 *     when: …  ended: …  said: "did: … doubted: … untouched: …"  files: 3  session: …  by: person
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument, YAMLSeq, YAMLMap } from "yaml";
import { claudeBinary } from "./model.ts";
import type { Agent } from "./tail.ts";

export type RunStatus = "running" | "done" | "failed" | "recalled" | "accepted";
/** evidence: the project's own tests, run on the ship's branch. pass or fail, never a score */
export type Tests = { status: "running" | "pass" | "fail" | "none" | "timeout" | "error"; pass?: number; fail?: number; tail?: string; at: string };
export type Run = { id: string; branch: string; status: RunStatus; when: string; by: "person"; base?: string; note?: string; session?: string; ended?: string; said?: string; files?: number; tests?: Tests };
type Hooks = { onChange: () => void };
type Options = { bin?: string; tools?: string[]; home?: string; env?: NodeJS.ProcessEnv; npm?: string; testTimeout?: number };

/** pass and fail counts from whatever reporter spoke: node's "ℹ pass 82", jest's "80 passed, 3 failed", vitest, pytest */
export function parseCounts(out: string): { pass?: number; fail?: number } {
  const last = (re: RegExp) => { let m: RegExpExecArray | null, v: number | undefined; while ((m = re.exec(out))) v = Number(m[1]); return v; };
  const pass = last(/\bpass(?:ed|ing)?\s+(\d+)\b/gi) ?? last(/\b(\d+)\s+pass(?:ed|ing)?\b/gi);
  const fail = last(/\bfail(?:ed|ing|ures?)?\s+(\d+)\b/gi) ?? last(/\b(\d+)\s+fail(?:ed|ing|ures?)?\b/gi);
  return { ...(pass !== undefined ? { pass } : {}), ...(fail !== undefined ? { fail } : {}) };
}

const DEFAULT_TOOLS = ["Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
  "Bash(npm test:*)", "Bash(npm run:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)"];
const textOf = (i: any): string => String(i?.get ? i.get("text") : (i?.value ?? i)).split(" | ")[0].trim();
const moreOf = (i: any): string => { if (i?.get && i.get("more")) return String(i.get("more")); const s = String(i?.get ? i.get("text") : (i?.value ?? i)); const k = s.indexOf(" | "); return k < 0 ? "" : s.slice(k + 3).trim(); };
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "star";
const hash = (s: string) => createHash("sha1").update(s).digest("hex");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** the star in the document: its area, which list it is in, and the entry as a map */
function locate(doc: ReturnType<typeof parseDocument>, area: string, text: string) {
  const stars = doc.get("stars", true) as YAMLSeq | undefined; if (!stars) return null;
  for (const star of stars.items as YAMLMap[]) {
    for (const a of ((star.get("areas", true) as YAMLSeq | undefined)?.items ?? []) as YAMLMap[]) {
      if (a.get("name") !== area) continue;
      for (const kind of ["todo", "open", "explore"] as const) {
        const seq = a.get(kind, true) as YAMLSeq | undefined; if (!seq) continue;
        const idx = (seq.items as any[]).findIndex((i) => textOf(i) === text);
        if (idx < 0) continue;
        let item = seq.items[idx] as any;
        // a plain "short | long" line becomes a map so the run can sit on it; the long half is kept as `more`
        if (!(item instanceof YAMLMap)) { const s = String(item?.value ?? item), k = s.indexOf(" | "); seq.set(idx, doc.createNode(k < 0 ? { text: s.trim() } : { text: s.slice(0, k).trim(), more: s.slice(k + 3).trim() })); item = seq.items[idx]; }
        return { star, area: a, kind, seq, idx, item: item as YAMLMap };
      }
      return { star, area: a, kind: null, seq: null, idx: -1, item: null };
    }
  }
  return null;
}
const runOf = (item: YAMLMap | null): Run | null => { const r = item?.get("run"); return r && typeof (r as any).toJSON === "function" ? (r as any).toJSON() as Run : (r as Run | null) ?? null; };

export class Dispatcher {
  private live = new Map<string, { child: ChildProcess | null; agent: Agent; area: string; text: string; dir: string }>();
  private home: string;
  constructor(private root: string, private hooks: Hooks, private opts: Options = {}) {
    this.home = opts.home ?? join(homedir(), ".skylight", "worktrees");
  }

  /** ships that are out, or just back — for the sky */
  agents(): Agent[] {
    const now = Date.now(), out: Agent[] = [];
    for (const [id, l] of this.live) {
      const a = l.agent;
      if (a.phase === "working") a.state = "active";
      else a.state = now - a.lastAt < 24 * 3600_000 ? "idle" : "gone";
      if (a.state === "gone") { this.live.delete(id); continue; }
      out.push(a);
    }
    return out;
  }

  /** a restart while ships were out: their runs are marked failed, honestly */
  sweep(): void {
    const file = join(this.root, "sky.yaml"); if (!existsSync(file)) return;
    const doc = parseDocument(readFileSync(file, "utf8")); let dirty = false;
    for (const star of ((doc.get("stars", true) as YAMLSeq | undefined)?.items ?? []) as YAMLMap[])
      for (const a of ((star.get("areas", true) as YAMLSeq | undefined)?.items ?? []) as YAMLMap[])
        for (const kind of ["todo", "open", "explore"])
          for (const item of ((a.get(kind, true) as YAMLSeq | undefined)?.items ?? []) as any[]) {
            if (!(item instanceof YAMLMap)) continue;
            const run = item.get("run", true) as YAMLMap | undefined;
            if (run?.get("status") === "running") { run.set("status", "failed"); run.set("ended", new Date().toISOString()); run.set("said", "skylight restarted while the ship was out"); dirty = true; }
          }
    if (dirty) writeFileSync(file, doc.toString());
  }

  private worktreeFor(branch: string): string {
    return join(this.home, `${basename(this.root)}-${hash(this.root).slice(0, 8)}`, branch.replace(/^sky\//, ""));
  }

  send(area: string, text: string, note = ""): { id?: string; error?: string } {
    try { git(this.root, ["rev-parse", "--is-inside-work-tree"]); } catch { return { error: "sending a ship needs a git repository — this project is not one" }; }
    const bin = this.opts.bin ?? claudeBinary(this.root);
    const file = join(this.root, "sky.yaml");
    const doc = parseDocument(readFileSync(file, "utf8"));
    const at = locate(doc, area, text);
    if (!at) return { error: `no area called ${area}` };
    if (!at.item) return { error: "no such star" };
    const prev = runOf(at.item);
    if (prev?.status === "running") return { error: "a ship is already on it" };
    if (prev?.status === "accepted") return { error: "that star has landed" };

    const revising = !!(prev && prev.session && (prev.status === "done" || prev.status === "failed" || prev.status === "recalled"));
    const branch = prev?.branch ?? `sky/${slugOf(area)}-${slugOf(text)}-${hash(area + text).slice(0, 4)}`;
    const dir = this.worktreeFor(branch);
    let base = prev?.base;
    try {
      git(this.root, ["worktree", "prune"]);
      if (!existsSync(dir)) {
        mkdirSync(dirname(dir), { recursive: true });
        const exists = (() => { try { git(this.root, ["rev-parse", "--verify", "--quiet", branch]); return true; } catch { return false; } })();
        if (exists) git(this.root, ["worktree", "add", dir, branch]);
        else { base = git(this.root, ["rev-parse", "HEAD"]); git(this.root, ["worktree", "add", "-b", branch, dir, "HEAD"]); }
      }
      base ??= git(this.root, ["merge-base", "HEAD", branch]);
      // a worktree has no installed packages; point it at the project's own, so the ship can run the tests
      if (existsSync(join(this.root, "node_modules")) && !existsSync(join(dir, "node_modules"))) { try { symlinkSync(join(this.root, "node_modules"), join(dir, "node_modules"), "dir"); } catch {} }
    } catch (e) { return { error: `could not make a worktree: ${(e as Error).message.split("\n").pop()}` }; }

    const id = prev?.id ?? `ship-${hash(branch + Date.now()).slice(0, 10)}`;
    const now = new Date().toISOString();
    const run: Run = { id, branch, status: "running", when: now, by: "person", base, ...(note ? { note } : {}), ...(prev?.session ? { session: prev.session } : {}) };
    at.item.set("run", doc.createNode(run));
    writeFileSync(file, doc.toString());

    const prompt = this.prompt(doc, at, text, note, branch, revising);
    const tools = this.opts.tools ?? (process.env.SKY_SHIP_TOOLS ? process.env.SKY_SHIP_TOOLS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TOOLS);
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", ...tools];
    if (revising && prev?.session) args.push("--resume", prev.session);
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;   // a ship is its own session, not a child of the one that sent it
    if (env.SKY_API_KEY) env.ANTHROPIC_API_KEY = env.SKY_API_KEY;

    const agent: Agent = { provider: "reported", id, short: id.slice(0, 8), cwd: dir, subagent: false, intent: text, lastAt: Date.now(), lastFile: null, lastTool: null,
      touched: [], tools: {}, state: "active", phase: "working", note: revising ? "going back with your note" : "on its way", noteAt: Date.now(), task: id, star: text, assignedArea: area };
    let child: ChildProcess;
    try { child = spawn(bin, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { this.finish(area, text, "failed", `could not start the ship: ${(e as Error).message}`); return { error: "could not start the ship" }; }
    this.live.set(id, { child, agent, area, text, dir });

    let carry = "", session: string | undefined, said = "", isError = false, stderr = "";
    child.stdout!.on("data", (chunk) => {
      carry += chunk.toString("utf8"); const lines = carry.split("\n"); carry = lines.pop() ?? "";
      for (const l of lines) this.event(agent, dir, l, (s) => { session = s; }, (r, e) => { said = r; isError = e; });
    });
    child.stderr!.on("data", (c) => { stderr += c.toString("utf8"); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on("error", (e) => { this.finish(area, text, "failed", `the ship could not start: ${e.message}`, session); });
    child.on("exit", (code) => {
      if (carry.trim()) this.event(agent, dir, carry, (s) => { session = s; }, (r, e) => { said = r; isError = e; });
      const l = this.live.get(id); if (l && l.child === null) return;   // recalled: already recorded
      const ok = code === 0 && !isError;
      const why = said || (stderr.trim().split("\n").pop() ?? "").slice(0, 200) || `the ship exited with code ${code}`;
      this.finish(area, text, ok ? "done" : "failed", why, session);
    });
    this.hooks.onChange();
    return { id };
  }

  /** one line of the ship's stream: what it said, what it touched, how it ended */
  private event(agent: Agent, dir: string, line: string, onSession: (s: string) => void, onResult: (said: string, isError: boolean) => void): void {
    let j: any; try { j = JSON.parse(line); } catch { return; }
    if (j.type === "system" && j.subtype === "init" && typeof j.session_id === "string") onSession(j.session_id);
    if (j.type === "assistant" && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) { agent.note = b.text.replace(/\s+/g, " ").trim().slice(0, 160); agent.noteAt = Date.now(); }
        if (b.type === "tool_use") {
          agent.tools[b.name] = (agent.tools[b.name] ?? 0) + 1; agent.lastTool = b.name;
          const raw = b.input?.file_path ?? b.input?.notebook_path;
          if (typeof raw === "string") {
            const abs = isAbsolute(raw) ? raw : resolve(dir, raw);
            if (abs === dir || abs.startsWith(dir + sep)) { const rel = relative(dir, abs).split(sep).join("/"); agent.lastFile = rel; agent.touched.push({ file: rel, at: Date.now(), tool: b.name }); if (agent.touched.length > 400) agent.touched.shift(); }
          }
        }
      }
      agent.lastAt = Date.now(); agent.phase = "working";
      this.hooks.onChange();
    }
    if (j.type === "result") onResult(typeof j.result === "string" ? j.result.trim().slice(0, 600) : "", !!j.is_error || (typeof j.subtype === "string" && j.subtype !== "success"));
  }

  private prompt(doc: ReturnType<typeof parseDocument>, at: NonNullable<ReturnType<typeof locate>>, text: string, note: string, branch: string, revising: boolean): string {
    const list = (k: string) => ((at.area.get(k, true) as YAMLSeq | undefined)?.items ?? []).map(textOf).filter(Boolean);
    const files = ((at.area.get("files", true) as YAMLSeq | undefined)?.items ?? []).map((f: any) => String(f?.value ?? f));
    const kind = at.kind === "open" ? "a question to answer, in code if it can be" : at.kind === "explore" ? "an exploration — try it, and say what you found" : "a to-do";
    const head = revising
      ? `The person looked at what you did on this branch and asks for a change:\n"${note}"\nContinue on the same branch.`
      : `You are a ship sent from Skylight to work on one star of the project "${doc.get("name")}"${doc.get("goal") ? ` — ${doc.get("goal")}` : ""}.
You are in a git worktree on branch ${branch}. Work only here.

Feature "${at.area.get("name")}": ${at.area.get("about") ?? ""}
Its files: ${files.join(", ") || "none mapped yet"}
Done so far:\n${list("done").map((d) => "- " + d).join("\n") || "- nothing yet"}
Open questions:\n${list("open").map((d) => "- " + d).join("\n") || "- none"}

The star, ${kind}: "${text}"${moreOf(at.item) ? `\n${moreOf(at.item)}` : ""}${note ? `\nA note from the person: ${note}` : ""}`;
    return `${head}

Do it. Stay inside this feature's files where you can; keep the change as small as the task allows. Run the project's tests if it has them. When you are finished, commit everything on this branch with a clear message (git add -A && git commit). Never push.
Then answer with exactly three short lines and nothing else:
did: <what you did>
doubted: <what you were unsure about>
untouched: <what you deliberately left alone>`;
  }

  /** the ship is back, one way or another: record it on the star */
  private finish(area: string, text: string, status: "done" | "failed" | "recalled", said: string, session?: string): void {
    const file = join(this.root, "sky.yaml");
    const doc = parseDocument(readFileSync(file, "utf8"));
    const at = locate(doc, area, text);
    const run = at?.item?.get("run", true) as YAMLMap | undefined;
    const l = [...this.live.values()].find((x) => x.area === area && x.text === text);
    let files = 0;
    if (l) {
      try {
        if (git(l.dir, ["status", "--porcelain"])) { git(l.dir, ["add", "-A"]); git(l.dir, ["-c", "user.name=skylight", "-c", "user.email=skylight@local", "commit", "-q", "-m", "What the ship left uncommitted"]); }
        const base = String(run?.get("base") ?? "") || git(this.root, ["rev-parse", "HEAD"]);
        files = git(l.dir, ["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean).length;
      } catch {}
      l.child = null;
      l.agent.phase = status === "done" ? "done" : "failed"; l.agent.state = "idle"; l.agent.lastAt = Date.now();
      l.agent.note = said.split("\n")[0].slice(0, 160); l.agent.noteAt = Date.now();
    }
    if (run) {
      run.set("status", status); run.set("ended", new Date().toISOString()); run.set("said", said.slice(0, 600)); run.set("files", files);
      if (session) run.set("session", session);
      writeFileSync(file, doc.toString());
    }
    this.hooks.onChange();
    if (l && status !== "recalled") this.evidence(area, text, l.dir);
  }

  /** step 3: evidence. the ship said what it did; the project's tests say whether it holds */
  private evidence(area: string, text: string, dir: string): void {
    if (/^(0|false|no|off)$/i.test((process.env.SKY_SHIP_TESTS ?? "").trim())) return;
    const write = (tests: Tests) => {
      const file = join(this.root, "sky.yaml");
      const doc = parseDocument(readFileSync(file, "utf8"));
      const run = locate(doc, area, text)?.item?.get("run", true) as YAMLMap | undefined;
      if (!run) return;
      run.set("tests", doc.createNode(tests)); writeFileSync(file, doc.toString()); this.hooks.onChange();
    };
    let script: unknown; try { script = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.test; } catch {}
    if (typeof script !== "string" || !script.trim()) { write({ status: "none", at: new Date().toISOString() }); return; }
    write({ status: "running", at: new Date().toISOString() });
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env), CI: "1" }; delete env.CLAUDECODE;
    let out = ""; const take = (c: Buffer) => { out += c.toString("utf8"); if (out.length > 30_000) out = out.slice(-30_000); };
    let child: ChildProcess;
    try { child = spawn(this.opts.npm ?? "npm", ["test", "--silent"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { write({ status: "error", tail: "could not run npm test", at: new Date().toISOString() }); return; }
    child.stdout!.on("data", take); child.stderr!.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, this.opts.testTimeout ?? 5 * 60_000);
    child.on("error", () => { clearTimeout(timer); write({ status: "error", tail: "could not run npm test", at: new Date().toISOString() }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const tail = out.split("\n").map((s) => s.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean).pop()?.slice(0, 160);
      write({ status: timedOut ? "timeout" : code === 0 ? "pass" : "fail", ...parseCounts(out), ...(tail ? { tail } : {}), at: new Date().toISOString() });
    });
  }

  /** run the evidence again — main may have moved under the branch, or the first run never happened */
  retest(area: string, text: string): string | null {
    const doc = parseDocument(readFileSync(join(this.root, "sky.yaml"), "utf8"));
    const at = locate(doc, area, text); if (!at) return `no area called ${area}`; if (!at.item) return "no such star";
    const run = runOf(at.item); if (!run) return "no ship was sent to that star";
    if (run.status === "running") return "the ship is still out"; if (run.status === "accepted") return "already landed";
    if (run.tests?.status === "running") return "the tests are already running";
    const dir = this.worktreeFor(run.branch); if (!existsSync(dir)) return "the ship's worktree is gone";
    this.evidence(area, text, dir); return null;
  }

  recall(area: string, text: string): string | null {
    const l = [...this.live.values()].find((x) => x.area === area && x.text === text && x.child);
    if (!l) return "no ship is out on that star";
    const child = l.child!; l.child = null;
    try { child.kill("SIGTERM"); } catch {}
    this.finish(area, text, "recalled", "recalled by the person");
    return null;
  }

  /** the person says yes: merge the branch, move the star to done, tidy the worktree */
  accept(area: string, text: string): string | null {
    const file = join(this.root, "sky.yaml");
    const doc = parseDocument(readFileSync(file, "utf8"));
    const at = locate(doc, area, text);
    if (!at) return `no area called ${area}`; if (!at.item || !at.seq) return "no such star";
    const run = runOf(at.item);
    if (!run) return "no ship was sent to that star";
    if (run.status === "running") return "the ship is still out";
    if (run.status === "accepted") return "already landed";
    try { git(this.root, ["merge", "--no-ff", "--no-edit", "-m", `Land: ${text}`, run.branch]); }
    catch (e) {
      try { git(this.root, ["merge", "--abort"]); } catch {}
      const why = (e as Error).message.split("\n").filter((s) => s && !s.startsWith("Command failed")).pop() ?? "";
      return `could not merge ${run.branch} — do it by hand${why ? `: ${why.slice(0, 160)}` : ""}`;
    }
    const now = new Date().toISOString();
    const done: Record<string, unknown> = { text: String(at.item.get("text")), landed: now, proof: `merged ${run.branch}`, by: "person" };
    for (const k of ["at", "when", "more"]) { const v = at.item.get(k); if (v !== undefined && v !== null) done[k] = (v as any).toJSON?.() ?? v; }
    done.run = { ...run, status: "accepted", ended: run.ended ?? now };
    at.seq.delete(at.idx);
    if (!at.seq.items.length) at.area.delete(at.kind!);
    let dones = at.area.get("done", true) as YAMLSeq | undefined;
    if (!dones) { at.area.set("done", doc.createNode([done])); } else dones.add(doc.createNode(done));
    writeFileSync(file, doc.toString());
    try { git(this.root, ["worktree", "remove", "--force", this.worktreeFor(run.branch)]); } catch {}
    this.live.delete(run.id);
    this.hooks.onChange();
    return null;
  }
}
