/**
 * The orchestrator, smallest true version.
 *
 * It watches sky.yaml for stars a person placed that nothing has reached for
 * yet — an entry with `when` and `by: person` and no `seen`. For each one it
 * reads the feature around it (what it is, what is done, what is open, which
 * files it owns), asks the model what the star means there, and writes back:
 *
 *   seen     when it reached for it
 *   context  its reading, one sentence — so you can check it before an agent spends anything
 *   near     which existing star it belongs beside — the joint the line reaches from
 *   and, for a question, one proposed to-do that would answer it, marked by: orchestrator
 *
 * It never moves anything into live, never deletes a line, never marks anything done.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, YAMLSeq, YAMLMap } from "yaml";
import { callModel, modelProvider } from "./model.ts";

const textOf = (i: any): string => String(i?.get ? i.get("text") : (i?.value ?? i)).split(" | ")[0].trim();

export async function orchestrate(root: string, limit = 2): Promise<{ reached: string[]; error?: string }> {
  const file = join(root, "sky.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  const stars = doc.get("stars", true) as YAMLSeq | undefined;
  if (!stars) return { reached: [] };
  const reached: string[] = [];

  for (const star of stars.items as YAMLMap[]) {
    const areas = star.get("areas", true) as YAMLSeq | undefined; if (!areas) continue;
    for (const area of areas.items as YAMLMap[]) {
      for (const kind of ["todo", "open", "explore"] as const) {
        const seq = area.get(kind, true) as YAMLSeq | undefined; if (!seq) continue;
        for (const item of seq.items as any[]) {
          if (!(item instanceof YAMLMap)) continue;
          if (item.get("by") !== "person" || !item.get("when") || item.get("seen")) continue;
          if (reached.length >= limit) return { reached };


          const list = (k: string) => ((area.get(k, true) as YAMLSeq | undefined)?.items ?? []).map(textOf).filter(Boolean);
          const done = list("done"), open = list("open"), files = ((area.get("files", true) as YAMLSeq | undefined)?.items ?? []).map((f: any) => String(f?.value ?? f));
          const text = String(item.get("text")), name = String(area.get("name")), about = String(area.get("about") ?? "");
          const prompt = `You are the orchestrator for a software project. A person just placed a star on the feature "${name}".
Feature: ${about}
Files: ${files.join(", ") || "none"}
Done: ${done.map((d) => "- " + d).join("\n") || "- nothing yet"}
Open questions: ${open.map((d) => "- " + d).join("\n") || "- none"}

The star: ${kind === "open" ? "a QUESTION" : kind === "todo" ? "a TO-DO" : "an EXPLORATION"} — "${text}"

Answer with JSON only, no prose, no fences:
{"context": "<one sentence: what this means here and where in the files it lives>",
 "near": "<the one Done item it belongs beside, copied exactly, or null>",
 "todo": ${kind === "open" ? '"<one short to-do that would answer the question, as: Short | longer line>"' : "null"}}`;

          let out = "";
          try {
            out = await callModel(root, prompt);
          } catch (e) { return { reached, error: `model call failed: ${(e as Error).message.split("\n")[0]}` }; }
          const m = out.match(/\{[\s\S]*\}/); if (!m) continue;
          let j: any; try { j = JSON.parse(m[0]); } catch { continue; }

          const latest = parseDocument(readFileSync(file, "utf8"));
          const currentStar = (latest.get("stars", true) as YAMLSeq)?.items.find((s: any) => s.get("name") === star.get("name")) as YAMLMap | undefined;
          const currentArea = (currentStar?.get("areas", true) as unknown as YAMLSeq)?.items.find((a: any) => a.get("name") === name) as YAMLMap | undefined;
          const currentItem = (currentArea?.get(kind, true) as unknown as YAMLSeq)?.items.find((i: any) =>
            i instanceof YAMLMap && i.get("text") === text && i.get("when") === item.get("when") && i.get("by") === "person" && !i.get("seen")) as YAMLMap | undefined;
          if (!currentArea || !currentItem) continue;
          currentItem.set("seen", new Date().toISOString());
          if (j.context) currentItem.set("context", String(j.context).slice(0, 220));
          if (j.near && done.includes(j.near)) currentItem.set("near", j.near);
          currentItem.set("agent", modelProvider());
          if (kind === "open" && typeof j.todo === "string" && j.todo.trim()) {
            let todos = currentArea.get("todo", true) as YAMLSeq | undefined;
            if (!todos) { todos = new YAMLSeq(); currentArea.set("todo", todos); }
            todos.add({ text: j.todo.trim().slice(0, 160), from: text, when: new Date().toISOString(), by: "orchestrator" });
          }
          // Persist each completed annotation, including when the batch limit is reached.
          writeFileSync(file, latest.toString());
          reached.push(`${name} · ${text}`);
        }
      }
    }
  }
  return { reached };
}

if (process.argv[1]?.endsWith("orchestrate.ts")) {
  const r = await orchestrate(process.argv[2] ?? process.cwd(), 10);
  if (r.error) console.error(r.error);
  console.log(r.reached.length ? r.reached.map((x) => "reached · " + x).join("\n") : "nothing new to reach for");
}
