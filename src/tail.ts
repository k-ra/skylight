/**
 * Agents, from Claude Code transcripts.
 *
 * Every session Claude Code runs writes a JSONL file under
 * ~/.claude/projects/<cwd, with slashes turned into dashes>/. Each record
 * carries the session id, the working directory, whether it is a subagent
 * (`isSidechain`), a timestamp, and — for tool calls — the file it touched.
 * That is enough to know who is here, where they are, and what they were
 * asked to do, without anyone reporting anything.
 *
 * The tailer polls those files for new bytes rather than watching them,
 * because fs.watch on a directory of large append-only files is unreliable on
 * macOS and a 1.5 second poll is invisible.
 */
import { existsSync, openSync, readSync, readdirSync, statSync, closeSync } from "node:fs";
import { updateObjective } from "./objectives.ts";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type Agent = {
  provider?: "claude" | "codex" | "reported";
  id: string; short: string; cwd: string; subagent: boolean;
  /** the first thing the person asked — the session's north star */
  intent: string | null;
  intentAt?: number; parentTask?: string; assignedArea?: string;
  where?: {sys:string; area:string; basis:"assigned"|"inferred"} | null;
  lastAt: number; lastFile: string | null; lastTool: string | null;
  /** files under the repo this session has touched, newest last */
  touched: { file: string; at: number; tool: string }[];
  /** which tools it reaches for — its character, roughly */
  tools: Record<string, number>;
  /** active: touched something in the last 10 minutes */
  state: "active" | "idle" | "unknown" | "gone";
  /** what the last record says it is doing. `waiting` means its turn ended with
   *  words and no tool call — it is waiting for the person. */
  phase?: "working" | "waiting" | "done" | "failed";
  /** the last thing it said, and when — a current description, not a saved label */
  note?: string | null; noteAt?: number;
  /** a stable task identity, when whoever runs it has one */
  task?: string | null;
  /** the star it was sent to, when a person dispatched it from the sky */
  star?: string;
};

const ACTIVE_MS = 10 * 60_000, GONE_MS = 24 * 3600_000;

export class Tailer {
  private offsets = new Map<string, number>();
  private agents = new Map<string, Agent>();
  private carry = new Map<string, string>();
  constructor(private root: string, private onChange: () => void, private dir = join(homedir(), ".claude", "projects")) {}

  private files(): string[] {
    const dir = this.dir;
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const d of readdirSync(dir)) {
      const p = join(dir, d);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) out.push(join(p, f));
    }
    return out;
  }

  /** absolute or repo-relative paths mentioned in a tool call, restricted to this repo */
  private pathsIn(input: any, cwd: string): string[] {
    const found = new Set<string>();
    const consider = (raw: string) => {
      const abs = isAbsolute(raw) ? raw : join(cwd, raw);
      if (!abs.startsWith(this.root + "/")) return;
      const rel = relative(this.root, abs);
      if (rel.startsWith("node_modules") || rel.startsWith(".git")) return;
      if (existsSync(abs) && statSync(abs).isFile()) found.add(rel);
    };
    if (typeof input?.file_path === "string") consider(input.file_path);
    if (typeof input?.command === "string")
      for (const m of input.command.matchAll(/(?:^|[\s"'=(])((?:\/|\.\/)?[\w.@-]+(?:\/[\w.@-]+)+\.[a-z]{1,5})/g)) consider(m[1]);
    return [...found];
  }

  poll(): void {
    let changed = false;
    for (const f of this.files()) {
      let size: number; try { size = statSync(f).size; } catch { continue; }
      const off = this.offsets.get(f) ?? 0;
      if (size <= off) continue;
      const fd = openSync(f, "r"); const buf = Buffer.alloc(size - off);
      readSync(fd, buf, 0, buf.length, off); closeSync(fd);
      this.offsets.set(f, size);
      const text = (this.carry.get(f) ?? "") + buf.toString("utf8");
      const lines = text.split("\n"); this.carry.set(f, lines.pop() ?? "");
      for (const l of lines) { if (l && this.ingest(l)) changed = true; }
    }
    // state decays with time even when nothing is written
    const now = Date.now();
    for (const a of this.agents.values()) {
      const s: Agent["state"] = now - a.lastAt < ACTIVE_MS ? "active" : now - a.lastAt < GONE_MS ? "idle" : "gone";
      if (s !== a.state) { a.state = s; changed = true; }
    }
    if (changed) this.onChange();
  }

  private ingest(line: string): boolean {
    let j: any; try { j = JSON.parse(line); } catch { return false; }
    if (!j.sessionId || !j.timestamp) return false;
    const at = Date.parse(j.timestamp); if (!Number.isFinite(at)) return false;
    const cwd = typeof j.cwd === "string" ? resolve(j.cwd) : this.agents.get(j.sessionId)?.cwd;
    if (!cwd || !(cwd === resolve(this.root) || cwd.startsWith(resolve(this.root) + "/"))) return false;
    const content = j.message?.content;
    let touched = false, changed = false;

    let a = this.agents.get(j.sessionId);
    if (!a) {
      a = { provider: "claude", id: j.sessionId, short: j.sessionId.slice(0, 8), cwd: j.cwd ?? "", subagent: !!j.isSidechain,
            intent: null, lastAt: 0, lastFile: null, lastTool: null, touched: [], tools: {}, state: "gone" };
      this.agents.set(j.sessionId, a);
    }
    if (j.type === "user" && typeof content === "string") updateObjective(a, content, at);
    // the phase. an assistant record with words and no tool call ends a turn: the
    // session is waiting for the person. anything after that means it is working again.
    if (j.type === "assistant" && Array.isArray(content)) {
      const said = content.filter((b: any) => b.type === "text" && typeof b.text === "string").map((b: any) => b.text.trim()).filter(Boolean).pop();
      const phase: Agent["phase"] = content.some((b: any) => b.type === "tool_use") ? "working" : "waiting";
      if (said) { a.note = said.replace(/\s+/g, " ").slice(0, 160); a.noteAt = at; changed = true; }
      if (phase !== a.phase) { a.phase = phase; changed = true; }
      if (at > a.lastAt) a.lastAt = at;
    } else if (j.type === "user" && a.phase !== "working") { a.phase = "working"; changed = true; if (at > a.lastAt) a.lastAt = at; }
    if (Array.isArray(content)) for (const b of content) {
      if (b.type !== "tool_use") continue;
      a.lastTool = b.name;
      a.tools[b.name] = (a.tools[b.name] ?? 0) + 1;
      for (const file of this.pathsIn(b.input, j.cwd ?? this.root)) {
        a.touched.push({ file, at, tool: b.name }); if (a.touched.length > 400) a.touched.shift();
        a.lastFile = file; a.lastTool = b.name; touched = true;
      }
    }
    if (touched && at > a.lastAt) a.lastAt = at;
    return touched || changed;
  }

  /** everyone who has touched this repo and is not long gone */
  list(): Agent[] {
    return [...this.agents.values()].filter((a) => a.lastAt > 0 && a.state !== "gone")
      .sort((x, y) => y.lastAt - x.lastAt);
  }
}

if (process.argv[1]?.endsWith("tail.ts")) {
  const t = new Tailer(process.cwd(), () => {});
  t.poll();
  for (const a of t.list())
    console.log(`${a.state.padEnd(6)} ${(a.phase ?? "").padEnd(7)} ${a.short}${a.subagent ? " (subagent)" : ""}  ${new Date(a.lastAt).toISOString().slice(11, 16)}  ${a.lastFile}\n       ${a.note ?? a.intent ?? "—"}`);
}
