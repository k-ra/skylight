import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tailer } from "./tail.ts";

/** A transcript the way Claude Code writes one: one JSON record per line. */
function transcript(root: string, projects: string, lines: object[]): string {
  const dir = join(projects, "some-project"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "s1.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const rec = (type: string, content: unknown, at: number, root: string) => ({ sessionId: "s1", timestamp: new Date(at).toISOString(), cwd: root, type, message: { content } });

test("a turn that ends with words is a ship waiting for the person; the next record puts it back to work", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sky-tail-")), root = join(tmp, "repo"), projects = join(tmp, "projects");
  mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  const now = Date.now();
  const file = transcript(root, projects, [
    rec("user", "fix the login", now - 3000, root),
    rec("assistant", [{ type: "text", text: "Looking at it." }, { type: "tool_use", name: "Edit", input: { file_path: join(root, "src/a.ts") } }], now - 2000, root),
    rec("assistant", [{ type: "text", text: "Should I also rename the   session cookie?" }], now - 1000, root),
  ]);
  try {
    const t = new Tailer(root, () => {}, projects); t.poll();
    const [a] = t.list();
    assert.ok(a, "the session touched a repo file, so it is on the sky");
    assert.equal(a.phase, "waiting");
    assert.equal(a.note, "Should I also rename the session cookie?");
    assert.equal(a.noteAt, now - 1000);
    assert.equal(a.state, "active");
    assert.equal(a.intent, "fix the login");

    appendFileSync(file, JSON.stringify(rec("user", "yes", now, root)) + "\n");
    t.poll();
    assert.equal(t.list()[0].phase, "working");
    assert.equal(t.list()[0].note, "Should I also rename the session cookie?", "the last thing it said stays until it says something else");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
