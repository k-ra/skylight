/** Best-effort local Codex activity. Only sessions rooted in this project are read. */
import { existsSync, closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { updateObjective } from "./objectives.ts";
import type { Agent } from "./tail.ts";

const DAY = 86_400_000, CHUNK = 256 * 1024, MAX_LINE = 1024 * 1024;
const canonical = (path: string): string => {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { return dirname(abs) === abs ? abs : join(canonical(dirname(abs)), basename(abs)); }
};
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
type Cursor = { offset: number; carry: string; decoder: StringDecoder; skipLine: boolean; id: string; cwd: string };
type Options = { sessionsDir?: string; worktrees?: string[]; excludePaths?: string[]; now?: () => number };

export class CodexTailer {
  private root: string;
  private roots: string[];
  private directory: string;
  private excludedRoots: string[];
  private now: () => number;
  private excluded = new Map<string, number>();
  private cursors = new Map<string, Cursor>();
  private agents = new Map<string, Agent>();
  private active = new Set<string>();
  private nextDiscovery = 0;

  constructor(root: string, private onChange: () => void, options: Options = {}) {
    this.root = canonical(root);
    this.roots = [this.root, ...(options.worktrees ?? []).map(canonical)];
    this.excludedRoots = this.roots.flatMap(root => (options.excludePaths ?? []).map(p => canonical(resolve(root, p))));
    this.directory = options.sessionsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    this.now = options.now ?? Date.now;
  }

  private discover(dir = this.directory): void {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { this.discover(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || this.cursors.has(path)) continue;
      let fd: number | undefined;
      try {
        const stats = statSync(path);
        if (stats.mtimeMs < this.now() - DAY || this.excluded.get(path) === stats.mtimeMs) continue;
        fd = openSync(path, "r");
        const first = Buffer.alloc(Math.min(stats.size, MAX_LINE));
        const n = readSync(fd, first, 0, first.length, 0);
        const line = first.subarray(0, n).toString("utf8").split("\n")[0];
        const meta = JSON.parse(line);
        const data = meta.payload;
        if (meta.type !== "session_meta" || typeof data?.id !== "string" || typeof data.cwd !== "string") continue;
        let cwd = canonical(data.cwd);
        if (!this.roots.some(root => inside(root, cwd))) {
          // A moved task may retain its original, now missing session cwd. Only
          // admit it on explicit recent execution-directory evidence, never a
          // matching folder name or a path mentioned in prose.
          let relocated: string | undefined;
          if (!existsSync(cwd)) {
            const length = Math.min(stats.size, 2 * 1024 * 1024), bytes = Buffer.alloc(length);
            readSync(fd, bytes, 0, length, stats.size-length);
            for (const raw of bytes.toString('utf8').split('\n')) {
              let record; try { record = JSON.parse(raw); } catch { continue; }
              const p = record.payload;
              const dirs: string[] = [];
              if (record.type === 'turn_context' && typeof p?.cwd === 'string') dirs.push(p.cwd);
              if (record.type === 'response_item' && ['function_call','custom_tool_call'].includes(p?.type)) {
                const input = String(p.arguments ?? p.input ?? '');
                for (const m of input.matchAll(/\bworkdir["']?\s*:\s*["']([^"']+)["']/g)) dirs.push(m[1]);
              }
              for (const dir of dirs) if (isAbsolute(dir) && this.roots.some(root => inside(root, canonical(dir)))) relocated = canonical(dir);
            }
          }
          if (!relocated) { this.excluded.set(path, stats.mtimeMs); continue; }
          cwd = relocated;
        }
        // Product runs and internal review/helper sessions are not coding workers.
        const subagent = typeof data.source === "object" ? data.source?.subagent : null;
        if (this.excludedRoots.some(root => inside(root, cwd)) || (subagent && !subagent.thread_spawn)) {
          this.excluded.set(path, stats.mtimeMs); continue;
        }
        // Read at most the final 2 MiB initially; do not replay years of transcript history.
        const offset = Math.max(Buffer.byteLength(line) + 1, stats.size - 2 * 1024 * 1024);
        this.cursors.set(path, { offset, carry: "", decoder: new StringDecoder("utf8"), skipLine: offset > Buffer.byteLength(line) + 1, id: data.id, cwd });
        this.agents.set(data.id, {
          id: data.id, short: data.id.slice(0, 8), cwd, provider: "codex",
          subagent: typeof data.source === "object" && !!data.source?.subagent,
          parentTask: subagent?.thread_spawn?.parent_thread_id, task: data.id,
          intent: null, lastAt: 0, lastFile: null, lastTool: null, touched: [], tools: {}, state: "gone",
        });
      } catch { /* incomplete, inaccessible or incompatible session */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }

  private file(raw: string, cwd: string, allowMissing: boolean): string | null {
    const abs = canonical(isAbsolute(raw) ? raw : resolve(cwd, raw));
    const root = this.roots.find(root => inside(root, abs));
    if (!root) return null;
    const path = relative(root, abs).split(sep).join("/");
    if (!path || path.split("/").some(p => p === ".git" || p === "node_modules")) return null;
    // Ignore arbitrary prose that looks like a path. Deleted files still count when
    // explicitly named by a patch, but directory activity does not become a file.
    try { if (!statSync(abs).isFile()) return null; } catch { if (!allowMissing || !/\.[\w-]+$/.test(path)) return null; }
    return path;
  }

  private paths(input: unknown, cwd: string): string[] {
    const found = new Set<string>();
    const consider = (path: string, base = cwd, explicit = false) => { const file = this.file(path, base, explicit); if (file) found.add(file); };
    const walk = (value: unknown, base: string, depth = 0): void => {
      if (depth > 8) return;
      if (typeof value === "string") {
        try { const parsed = JSON.parse(value); if (typeof parsed !== "string") { walk(parsed, base, depth + 1); return; } } catch {}
        for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) consider(match[1], base, true);
        for (const match of value.matchAll(/(?:^|[\s"'`=(])((?:\/?[\w.@+-]+\/)*[\w.@+-]+\.[a-zA-Z0-9]{1,12})(?=$|[\s"'`:),;])/g)) consider(match[1], base);
      } else if (Array.isArray(value)) {
        for (const item of value) walk(item, base, depth + 1);
      } else if (value && typeof value === "object") {
        const data = value as Record<string, unknown>;
        const dir = typeof data.workdir === "string" ? resolve(base, data.workdir) : base;
        for (const [key, item] of Object.entries(data)) {
          if (["file", "file_path", "path"].includes(key) && typeof item === "string") consider(item, dir, true);
          else if (key !== "cwd" && key !== "workdir") walk(item, dir, depth + 1);
        }
      }
    };
    walk(input, cwd);
    return [...found];
  }

  private ingest(line: string, cursor: Cursor): boolean {
    let record; try { record = JSON.parse(line); } catch { return false; }
    const p = record.payload;
    const at = Date.parse(record.timestamp);
    if (!p || !Number.isFinite(at)) return false;
    const a = this.agents.get(cursor.id)!;
    if (record.type === "turn_context" && typeof p.cwd === "string") cursor.cwd = canonical(p.cwd);
    if (record.type === "event_msg") {
      if (p.type === "task_started") { this.active.add(a.id); a.phase = "working"; a.lastAt = Math.max(a.lastAt, at); return true; }
      if (["task_complete", "task_completed", "turn_aborted", "task_failed"].includes(p.type)) {
        this.active.delete(a.id); a.phase = p.type === "task_failed" || p.type === "turn_aborted" ? "failed" : "done"; a.lastAt = Math.max(a.lastAt, at); return true;
      }
    }
    if (record.type !== "response_item") return false;
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      updateObjective(a, p.content.map((part: any) => part.text ?? "").join("\n"), at);
      return true;
    }
    if (p.type === "message" && p.role === "assistant" && (p.channel === undefined || ['commentary','final'].includes(p.channel)) && Array.isArray(p.content)) {
      const text = p.content.map((part: any) => part.text ?? '').join(' ').trim();
      if (text) { a.note = text.replace(/\s+/g,' ').slice(0,320); a.noteAt = at; a.lastAt = Math.max(a.lastAt,at); }
      return !!text;
    }
    if (p.type !== "function_call" && p.type !== "custom_tool_call") return false;
    let tool = String(p.name ?? "tool");
    if (tool === 'exec' || tool === 'functions.exec') {
      const names = [...String(p.input ?? p.arguments ?? '').matchAll(/tools\.([\w]+)\s*\(/g)].map(m => m[1]);
      if (names.length) tool = [...new Set(names)].slice(0,3).join(', ');
    }
    a.phase = "working";
    this.active.add(a.id); // The turn-start record may precede the bounded history window.
    a.lastAt = Math.max(a.lastAt, at); a.lastTool = tool;
    a.tools[tool] = (a.tools[tool] ?? 0) + 1;
    for (const file of this.paths(p.arguments ?? p.input, cursor.cwd)) {
      a.lastFile = file; a.touched.push({ file, at, tool });
    }
    a.touched = a.touched.slice(-400);
    return true;
  }

  poll(): void {
    const now = this.now();
    if (now >= this.nextDiscovery) { this.discover(); this.nextDiscovery = now + 15_000; }
    let changed = false, budget = 2 * 1024 * 1024;
    for (const [path, cursor] of this.cursors) {
      if (budget <= 0) break;
      let fd: number | undefined;
      try {
        const size = statSync(path).size;
        if (size < cursor.offset) {
          cursor.offset = 0; cursor.carry = ""; cursor.skipLine = false; cursor.decoder = new StringDecoder("utf8");
        }
        const length = Math.min(CHUNK, size - cursor.offset, budget);
        if (length <= 0) continue;
        fd = openSync(path, "r"); const bytes = Buffer.alloc(length);
        const n = readSync(fd, bytes, 0, length, cursor.offset); cursor.offset += n; budget -= n;
        let text = cursor.carry + cursor.decoder.write(bytes.subarray(0, n)); cursor.carry = "";
        if (cursor.skipLine) {
          const newline = text.indexOf("\n"); if (newline < 0) continue;
          text = text.slice(newline + 1); cursor.skipLine = false;
        }
        const lines = text.split("\n"); cursor.carry = lines.pop() ?? "";
        for (const line of lines) if (line.length <= MAX_LINE && this.ingest(line, cursor)) changed = true;
        if (cursor.carry.length > MAX_LINE) { cursor.carry = ""; cursor.skipLine = true; }
      } catch { /* disappearing/rotating sessions must not interrupt the server */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    for (const a of this.agents.values()) {
      const age = now - a.lastAt;
      const state = age >= DAY ? "gone" : this.active.has(a.id) ? (age < 10 * 60_000 ? "active" : "unknown") : "idle";
      if (state !== a.state) { a.state = state; changed = true; }
    }
    if (changed) this.onChange();
  }

  list(): Agent[] { return [...this.agents.values()].filter(a => a.lastAt > 0 && a.state !== "gone"); }
}
