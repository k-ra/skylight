/**
 * The derived sky. Reads sky.yaml and the repository, and returns the shape
 * the page draws. Nothing here is typed by hand except what sky.yaml says;
 * rings, ticks, todos and explorations all come from files, tests and git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

export type Proposal2 = { kind: string; text: string; by?: string; when?: string };
/** a ship a person sent to this star, and how it came back */
export type RunInfo = { id: string; branch: string; status: string; when?: string; ended?: string; said?: string; files?: number; note?: string; tests?: { status: string; pass?: number; fail?: number; tail?: string; at?: string } };
export type Item = { kind: "done" | "todo" | "open" | "explore"; text: string; more: string; src?: string; at?: [number, number]; when?: string; by?: string; seen?: string; context?: string; near?: string; from?: string; reconciled?: string; restates?: string; addresses_question?: boolean; proposes?: Proposal2[]; run?: RunInfo; landed?: string; proof?: string };
export type Area = {
  name: string; about: string; ring: number; ticks: number; files: number; lines: number;
  paths: string[]; items: Item[]; lastTouched: number | null;
};
export type Star = { name: string; goal: string; areas: Area[] };
export type Idea = { text: string; more: string; at?: [number, number] };
export type Proposal = { name: string; star: string; about: string; ideas: string[] };
export type Sky = {
  activity?: { excludePaths: string[]; labels: Record<string, string> };
  name: string; goal: string; at: number; stars: Star[]; ideas: Idea[]; proposed: Proposal[];
  branches: { name: string; areas: string[]; files: number }[];
  worktrees: { path: string; branch: string }[];
};

const RING = ["planned", "started", "built", "tests mapped", "live"];
export const ringName = (r: number) => RING[r];

const git = (root: string, args: string[]): string => {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};

/** "Short | the longer line" → { text, more }. A map entry may also carry `at`, where a person put it. */
function split(s: string): { text: string; more: string } {
  const i = s.indexOf(" | ");
  return i < 0 ? { text: s.trim(), more: "" } : { text: s.slice(0, i).trim(), more: s.slice(i + 3).trim() };
}
function entry(e: any): { text: string; more: string; at?: [number, number]; when?: string; by?: string; answer?: string; reconciled?: string; restates?: string; addresses_question?: boolean; proposes?: Proposal2[] } {
  if (typeof e === "string") return split(e);
  const base: any = split(String(e?.text ?? ""));
  if (e?.more && !base.more) base.more = String(e.more);
  const at = Array.isArray(e?.at) && e.at.length === 2 ? [Number(e.at[0]), Number(e.at[1])] as [number, number] : undefined;
  if (at) base.at = at;
  if (e?.when) base.when = String(e.when);
  if (e?.by) base.by = String(e.by);
  if (e?.answer) base.answer = String(e.answer);
  for (const k of ["seen", "context", "near", "from", "reconciled", "restates", "landed", "proof"]) if (e?.[k]) base[k] = String(e[k]);
  if (e?.run && typeof e.run === "object" && e.run.id) {
    const r = e.run;
    base.run = { id: String(r.id), branch: String(r.branch ?? ""), status: String(r.status ?? ""), when: r.when ? String(r.when) : undefined, ended: r.ended ? String(r.ended) : undefined,
      said: r.said ? String(r.said) : undefined, files: Number.isFinite(Number(r.files)) ? Number(r.files) : undefined, note: r.note ? String(r.note) : undefined };
    if (r.tests && typeof r.tests === "object" && r.tests.status) {
      const t = r.tests; base.run.tests = { status: String(t.status), ...(Number.isFinite(Number(t.pass)) && t.pass !== undefined ? { pass: Number(t.pass) } : {}),
        ...(Number.isFinite(Number(t.fail)) && t.fail !== undefined ? { fail: Number(t.fail) } : {}), ...(t.tail ? { tail: String(t.tail) } : {}), ...(t.at ? { at: String(t.at) } : {}) };
    }
  }
  // The orchestrator's proposed consequences travel to the page so a person can
  // accept or reject them there. Structured, not stringified.
  if (typeof e?.addresses_question === "boolean") base.addresses_question = e.addresses_question;
  if (Array.isArray(e?.proposes)) {
    const ps = e.proposes
      .map((p: any) => ({ kind: String(p?.kind ?? "acceptance"), text: String(p?.text ?? "").trim(), by: String(p?.by ?? ""), when: String(p?.when ?? "") }))
      .filter((p: Proposal2) => p.text);
    if (ps.length) base.proposes = ps;
  }
  return base;
}

function glob(root: string, patterns: string[] | undefined): string[] {
  if (!patterns?.length) return [];
  const out = new Set<string>();
  for (const p of patterns) for (const f of globSync(p, { cwd: root })) {
    const full = join(root, f);
    if (existsSync(full) && statSync(full).isFile()) out.add(f);
  }
  return [...out].sort();
}

function countLines(root: string, files: string[]): number {
  let n = 0;
  for (const f of files) n += readFileSync(join(root, f), "utf8").split("\n").length;
  return n;
}

/** Test declarations in mapped files. This does not run tests or assert that they pass. */
function countTests(root: string, files: string[]): number {
  let n = 0;
  for (const f of files) n += (readFileSync(join(root, f), "utf8").match(/^\s*test\(/gm) ?? []).length;
  return n;
}

function todosIn(root: string, files: string[]): Item[] {
  const out: Item[] = [];
  for (const f of files) {
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    lines.forEach((l, i) => {
      const m = l.match(/\b(TODO|FIXME)\b:?\s*(.+)/);
      if (m) out.push({ kind: "todo", text: m[2].trim().slice(0, 48), more: `${f}:${i + 1}`, src: "code" });
    });
  }
  return out;
}

function lastTouched(root: string, files: string[]): number | null {
  if (!files.length) return null;
  const ts = git(root, ["log", "-1", "--format=%ct", "--", ...files]);
  return ts ? Number(ts) * 1000 : null;
}

export function readSky(root: string): Sky {
  const doc = parse(readFileSync(join(root, "sky.yaml"), "utf8"));
  const live = new Set<string>(doc.live ?? []);
  const main = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";

  // unmerged branches: real explorations
  const branches = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    .split("\n").filter((b) => b && b !== main && !git(root, ["merge-base", "--is-ancestor", b, main]).length && git(root, ["rev-list", "--count", `${main}..${b}`]) !== "0")
    .map((name) => ({ name, files: git(root, ["diff", "--name-only", `${main}...${name}`]).split("\n").filter(Boolean) }));
  const worktrees = git(root, ["worktree", "list", "--porcelain"]).split("\n\n").map((blk) => {
    const path = blk.match(/^worktree (.+)$/m)?.[1] ?? "", branch = blk.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "";
    return { path, branch };
  }).filter((w) => w.path && w.path !== root);

  const stars: Star[] = (doc.stars ?? []).map((s: any) => ({
    name: s.name, goal: s.goal ?? "",
    areas: (s.areas ?? []).map((a: any): Area => {
      const paths = glob(root, a.files), tests = glob(root, a.tests);
      const activityPaths = glob(root, a.activity);
      const lines = countLines(root, paths), ticks = countTests(root, tests);
      const ring = live.has(a.name) ? 4 : ticks > 0 ? 3 : paths.length ? (lines < 80 ? 1 : 2) : 0;
      const items: Item[] = [];
      for (const k of ["done", "todo", "open", "explore"] as const)
        for (const s of a[k] ?? []) {
          const e = entry(s);
          // An answer is not a completion. A question stays OPEN until someone
          // explicitly reconciles it (`reconciled:` set on the entry). The answer
          // rides along as hover text so it stays visible without being treated
          // as settled — otherwise answering a question makes it disappear.
          if (k === "open" && e.answer) {
            const settled = Boolean(e.reconciled);
            // Spread the rest so the orchestrator's own annotations (seen, context,
            // near, restates) survive onto an answered question instead of being
            // dropped — otherwise its reading is written to the file and never shown.
            const { answer, ...rest } = e;
            items.push({
              ...rest,
              kind: settled ? "done" : "open",
              more: answer,
              src: settled ? "reconciled" : "answered · not yet reconciled",
            });
            continue;
          }
          const { answer: _drop, ...rest } = e; items.push({ kind: k, ...rest, src: "sky.yaml" });
        }
      items.push(...todosIn(root, paths));
      for (const b of branches) {
        const hit = b.files.filter((f) => paths.includes(f));
        if (hit.length) items.push({ kind: "explore", text: `branch · ${b.name}`, more: `${hit.length} file${hit.length === 1 ? "" : "s"} in this area`, src: "git" });
      }
      return { name: a.name, about: a.about ?? "", ring, ticks, files: paths.length, lines, paths: [...new Set([...paths, ...activityPaths])], items, lastTouched: lastTouched(root, paths) };
    }),
  }));

  return {
    name: doc.name ?? relative(join(root, ".."), root), goal: doc.goal ?? "", at: Date.now(), stars, ideas: (doc.ideas ?? []).map(entry), proposed: doc.proposed ?? [],
    branches: branches.map((b) => ({
      name: b.name, files: b.files.length,
      areas: stars.flatMap((s) => s.areas).filter((a) => b.files.some((f) => a.paths.includes(f))).map((a) => a.name),
    })),
    activity: { labels: Object.fromEntries(Object.entries(doc.activity?.labels ?? {}).filter(([k,v]) => typeof v === "string").map(([k,v]) => [k, String(v)])), excludePaths: Array.isArray(doc.activity?.excludePaths) ? doc.activity.excludePaths.filter((p: unknown) => typeof p === "string") : [] },
    worktrees,
  };
}

/** Which area a file belongs to. The first match wins; files can be shared. */
export function areaOf(sky: Sky, file: string): { star: string; area: string } | null {
  for (const s of sky.stars) for (const a of s.areas) if (a.paths.includes(file)) return { star: s.name, area: a.name };
  return null;
}

if (process.argv[1]?.endsWith("read.ts")) {
  // Accept a repo path like orchestrate.ts does, so `tsx src/read.ts <repo>`
  // reads the sky you asked for rather than silently reading the one you are in.
  const sky = readSky(process.argv[2] ?? process.cwd());
  for (const s of sky.stars) {
    console.log(`\n${s.name.toUpperCase()}`);
    for (const a of s.areas)
      console.log(`  ${a.name.padEnd(14)} ${ringName(a.ring).padEnd(8)} ${String(a.ticks).padStart(2)} tests  ${String(a.files).padStart(2)} files  ${String(a.lines).padStart(5)} lines  ${a.items.length} items`);
  }
  console.log(`\nbranches: ${sky.branches.map((b) => b.name).join(", ") || "none"} · worktrees: ${sky.worktrees.length} · ideas: ${sky.ideas.length}`);
}
