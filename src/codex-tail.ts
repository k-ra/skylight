/** Best-effort local Codex activity. Only sessions rooted in this project are read. */
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Agent } from "./tail.ts";

const DAY = 86_400_000, CHUNK = 256 * 1024, MAX_LINE = 1024 * 1024;
const canonical = (path: string): string => {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { return dirname(abs) === abs ? abs : join(canonical(dirname(abs)), basename(abs)); }
};
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
type Cursor = { offset: number; carry: string; decoder: StringDecoder; skipLine: boolean; id: string; cwd: string };
type Options = { sessionsDir?: string; worktrees?: string[]; now?: () => number };

export class CodexTailer {
  private root: string;
  private roots: string[];
  private directory: string;
  private now: () => number;
  private excluded = new Set<string>();
  private cursors = new Map<string, Cursor>();
  private agents = new Map<string, Agent>();
  private active = new Set<string>();
  private nextDiscovery = 0;

  constructor(root: string, private onChange: () => void, options: Options = {}) {
    this.root = canonical(root);
    this.roots = [this.root, ...(options.worktrees ?? []).map(canonical)];
    this.directory = options.sessionsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    this.now = options.now ?? Date.now;
  }

  private discover(dir = this.directory): void {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { this.discover(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || this.cursors.has(path) || this.excluded.has(path)) continue;
      let fd: number | undefined;
      try {
        const stats = statSync(path);
        if (stats.mtimeMs < this.now() - DAY) continue;
        fd = openSync(path, "r");
        const first = Buffer.alloc(Math.min(stats.size, MAX_LINE));
        const n = readSync(fd, first, 0, first.length, 0);
        const line = first.subarray(0, n).toString("utf8").split("\n")[0];
        const meta = JSON.parse(line);
        const data = meta.payload;
        if (meta.type !== "session_meta" || typeof data?.id !== "string" || typeof data.cwd !== "string") continue;
        const cwd = canonical(data.cwd);
        if (!this.roots.some(root => inside(root, cwd))) { this.excluded.add(path); continue; }
        // Read at most the final 2 MiB initially; do not replay years of transcript history.
        const offset = Math.max(Buffer.byteLength(line) + 1, stats.size - 2 * 1024 * 1024);
        this.cursors.set(path, { offset, carry: "", decoder: new StringDecoder("utf8"), skipLine: offset > Buffer.byteLength(line) + 1, id: data.id, cwd });
        this.agents.set(data.id, {
          id: data.id, short: data.id.slice(0, 8), cwd, provider: "codex",
          subagent: typeof data.source === "object" && !!data.source?.subagent,
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
      if (p.type === "task_started") { this.active.add(a.id); a.lastAt = Math.max(a.lastAt, at); return true; }
      if (["task_complete", "task_completed", "turn_aborted", "task_failed"].includes(p.type)) {
        this.active.delete(a.id); a.lastAt = Math.max(a.lastAt, at); return true;
      }
    }
    if (record.type !== "response_item") return false;
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      const text = p.content.map((part: any) => part.text ?? "").join("\n")
        .replace(/<(environment_context|in-app-browser-context|system-reminder)[\s\S]*?<\/\1>/g, "").trim();
      if (text && !text.startsWith("<")) a.intent = text.split("## My request:").at(-1)!.trim().slice(0, 160);
      return true;
    }
    if (p.type !== "function_call" && p.type !== "custom_tool_call") return false;
    const tool = String(p.name ?? "tool");
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
      const state = age >= DAY ? "gone" : this.active.has(a.id) && age < 10 * 60_000 ? "active" : "idle";
      if (state !== a.state) { a.state = state; changed = true; }
    }
    if (changed) this.onChange();
  }

  list(): Agent[] { return [...this.agents.values()].filter(a => a.lastAt > 0 && a.state !== "gone"); }
}
