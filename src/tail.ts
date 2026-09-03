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
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

export type Agent = {
  id: string; short: string; cwd: string; subagent: boolean;
  /** the first thing the person asked — the session's north star */
  intent: string | null;
  lastAt: number; lastFile: string | null; lastTool: string | null;
  /** files under the repo this session has touched, newest last */
  touched: { file: string; at: number; tool: string }[];
  /** which tools it reaches for — its character, roughly */
  tools: Record<string, number>;
  /** active: touched something in the last 10 minutes */
  state: "active" | "idle" | "gone";
};

const ACTIVE_MS = 10 * 60_000, GONE_MS = 24 * 3600_000;

export class Tailer {
  private offsets = new Map<string, number>();
  private agents = new Map<string, Agent>();
  private carry = new Map<string, string>();
  constructor(private root: string, private onChange: () => void) {}

  private files(): string[] {
    const dir = join(homedir(), ".claude", "projects");
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
    const content = j.message?.content;
    let touched = false;

    let a = this.agents.get(j.sessionId);
    if (!a) {
      a = { id: j.sessionId, short: j.sessionId.slice(0, 8), cwd: j.cwd ?? "", subagent: !!j.isSidechain,
            intent: null, lastAt: 0, lastFile: null, lastTool: null, touched: [], tools: {}, state: "gone" };
      this.agents.set(j.sessionId, a);
    }
    if (j.type === "user" && !a.intent && typeof content === "string" && content.trim() && !content.startsWith("<"))
      a.intent = content.trim().slice(0, 160);
    if (Array.isArray(content)) for (const b of content) {
      if (b.type !== "tool_use") continue;
      a.tools[b.name] = (a.tools[b.name] ?? 0) + 1;
      for (const file of this.pathsIn(b.input, j.cwd ?? this.root)) {
        a.touched.push({ file, at, tool: b.name }); if (a.touched.length > 400) a.touched.shift();
        a.lastFile = file; a.lastTool = b.name; touched = true;
      }
    }
    if (touched && at > a.lastAt) a.lastAt = at;
    return touched;
  }

  /** everyone who has touched this repo and is not long gone */
  list(): Agent[] {
    return [...this.agents.values()].filter((a) => a.touched.length && a.state !== "gone")
      .sort((x, y) => y.lastAt - x.lastAt);
  }
}

if (process.argv[1]?.endsWith("tail.ts")) {
  const t = new Tailer(process.cwd(), () => {});
  t.poll();
  for (const a of t.list())
    console.log(`${a.state.padEnd(6)} ${a.short}${a.subagent ? " (subagent)" : ""}  ${new Date(a.lastAt).toISOString().slice(11, 16)}  ${a.lastFile}\n       ${a.intent ?? "—"}`);
}
