/**
 * Gather: an agent reads the loose ideas and proposes areas.
 *
 * Propose, never commit. The proposals land under `proposed:` in sky.yaml,
 * drawn as dotted clusters on the sky; a person accepts one — it becomes an
 * area under the star it names, its ideas turned into to-dos — or vetoes it.
 * Nothing moves on its own.
 *
 * The model is reached through the Claude Code binary (`claude -p`), which
 * uses whatever the person is already signed in with. No key handling here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

export type Proposal = { name: string; star: string; about: string; ideas: string[] };

function claudeBin(root: string): string | null {
  const candidates = [
    process.env.SKY_CLAUDE,
    ...["claude-agent-sdk-darwin-arm64", "claude-agent-sdk-darwin-x64", "claude-agent-sdk-linux-x64"].flatMap((p) => [
      join(root, "node_modules", "@anthropic-ai", p, "claude"),
      join(process.cwd(), "node_modules", "@anthropic-ai", p, "claude"),
    ]),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  try { return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null; } catch { return null; }
}

export function gather(root: string): { proposals: Proposal[]; error?: string } {
  const file = join(root, "sky.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  const data: any = doc.toJS();
  const ideas: string[] = (data.ideas ?? []).map((i: any) => (typeof i === "string" ? i : i?.text ?? "")).filter(Boolean);
  const stars: string[] = (data.stars ?? []).map((s: any) => s.name);
  if (ideas.length < 2) return { proposals: [], error: "fewer than two loose ideas — nothing to gather" };
  const bin = claudeBin(root);
  if (!bin) return { proposals: [], error: "no claude binary found — set SKY_CLAUDE to the path of one" };

  const prompt = `You are grouping loose ideas for a software project called "${data.name}" (${data.goal ?? ""}).
The project has these north stars (its major parts): ${stars.join(", ")}.

Loose ideas, one per line:
${ideas.map((i) => `- ${i}`).join("\n")}

Group ideas that belong together into proposed AREAS. An area is a coherent piece of work with a two-word lowercase name, a one-sentence "about", the north star it belongs under (one of: ${stars.join(", ")}), and the ideas that make it up, quoted EXACTLY as given above. An idea may appear in at most one area. Leave out ideas that stand alone. Propose between one and four areas, only where the grouping is genuinely coherent.

Answer with JSON only, no prose, no fences: [{"name":"...","star":"...","about":"...","ideas":["..."]}]`;

  let out = "";
  try {
    out = execFileSync(bin, ["-p", prompt, "--output-format", "text"], {
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.SKY_API_KEY ?? "" },
    });
  } catch (e) {
    return { proposals: [], error: `the model call failed: ${(e as Error).message.split("\n")[0]}` };
  }
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return { proposals: [], error: "the model did not answer with a list" };
  let parsed: Proposal[];
  try { parsed = JSON.parse(m[0]); } catch { return { proposals: [], error: "the model's list was not valid JSON" }; }
  const proposals = parsed
    .filter((p) => p && p.name && stars.includes(p.star) && Array.isArray(p.ideas) && p.ideas.length)
    .map((p) => ({ name: String(p.name).toLowerCase().slice(0, 32), star: p.star, about: String(p.about ?? "").slice(0, 160),
                   ideas: p.ideas.filter((i) => ideas.includes(i)) }))
    .filter((p) => p.ideas.length);
  doc.set("proposed", proposals);
  writeFileSync(file, doc.toString());
  return { proposals };
}

/** Accept: the proposal becomes an area under its star; its ideas become to-dos. Veto: it goes. */
export function decide(root: string, name: string, action: "accept" | "veto"): string | null {
  const file = join(root, "sky.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  const data: any = doc.toJS();
  const proposals: Proposal[] = data.proposed ?? [];
  const p = proposals.find((x) => x.name === name);
  if (!p) return `no proposal called ${name}`;
  if (action === "accept") {
    const stars: any[] = data.stars ?? [];
    const star = stars.find((s) => s.name === p.star);
    if (!star) return `no star called ${p.star}`;
    star.areas = star.areas ?? [];
    star.areas.push({ name: p.name, about: p.about, files: [], todo: p.ideas });
    const taken = new Set(p.ideas);
    data.ideas = (data.ideas ?? []).filter((i: any) => !taken.has(typeof i === "string" ? i : i?.text));
    doc.set("stars", stars); doc.set("ideas", data.ideas);
  }
  doc.set("proposed", proposals.filter((x) => x.name !== name));
  writeFileSync(file, doc.toString());
  return null;
}

if (process.argv[1]?.endsWith("gather.ts")) {
  const r = gather(process.argv[2] ?? process.cwd());
  if (r.error) { console.error(r.error); process.exit(1); }
  for (const p of r.proposals) console.log(`${p.name} · under ${p.star}\n  ${p.about}\n  ${p.ideas.map((i) => "- " + i).join("\n  ")}`);
}
