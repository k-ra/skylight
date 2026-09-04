import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { callModel } from "./model.ts";
import { gather } from "./gather.ts";
import { orchestrate } from "./orchestrate.ts";

const dirs: string[] = [];
const original = { ...process.env };
afterEach(() => {
  for (const key of ["SKY_MODEL_PROVIDER", "SKY_CODEX", "SKY_CLAUDE", "SKY_TEST_OUTPUT"]) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skylight-model-test-")); dirs.push(root);
  const bin = join(root, "fake-cli.cjs");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let prompt='';process.stdin.on('data', c => prompt+=c);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json',JSON.stringify({args:process.argv.slice(2),prompt}));
  setTimeout(() => {
    const at=process.argv.indexOf('--output-last-message');
    if(at>=0) fs.writeFileSync(process.argv[at+1], process.env.SKY_TEST_OUTPUT);
    else process.stdout.write(process.env.SKY_TEST_OUTPUT);
  },80);
});
`); chmodSync(bin, 0o755);
  process.env.SKY_CODEX = bin; process.env.SKY_CLAUDE = bin;
  process.env.SKY_MODEL_PROVIDER = "codex";
  return root;
}

test("Codex planning uses stdin, read-only permissions, and the configured default model", async () => {
  const root = fixture(); process.env.SKY_TEST_OUTPUT = '{"ok":true}';
  let ticked = false; const timer = setTimeout(() => { ticked = true; }, 5);
  assert.equal(await callModel(root, "private planning prompt"), '{"ok":true}'); clearTimeout(timer);
  assert.ok(ticked, "model calls must yield to the event loop");
  const invocation = JSON.parse(readFileSync(join(root, "invocation.json"), "utf8"));
  assert.ok(invocation.args.includes("read-only")); assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(!invocation.args.includes("--model")); assert.ok(!invocation.args.includes("private planning prompt"));
  assert.match(invocation.prompt, /private planning prompt/);
});

test("Claude remains selectable with the same response contract", async () => {
  const root = fixture(); process.env.SKY_MODEL_PROVIDER = "claude"; process.env.SKY_TEST_OUTPUT = "[]";
  assert.equal(await callModel(root, "group ideas"), "[]");
  const { args } = JSON.parse(readFileSync(join(root, "invocation.json"), "utf8"));
  assert.deepEqual(args, ["-p", "--output-format", "text"]);
});

test("gather preserves edits made while the model is running", async () => {
  const root = fixture(), file = join(root, "sky.yaml");
  const sky = { name: "test", ideas: ["one", "two"], stars: [{ name: "Inquiry", areas: [] }] };
  writeFileSync(file, stringify(sky));
  process.env.SKY_TEST_OUTPUT = JSON.stringify([{ name: "research", star: "Inquiry", about: "Evidence", ideas: ["one", "two"] }]);
  const pending = gather(root);
  writeFileSync(file, stringify({ ...sky, goal: "Keep this edit" }));
  assert.equal((await pending).proposals.length, 1);
  assert.equal(parse(readFileSync(file, "utf8")).goal, "Keep this edit");
  const second = gather(root); writeFileSync(file, stringify({ ...sky, ideas: ["one", "two", "three"] }));
  assert.match((await second).error!, /Ideas changed/);
  assert.equal(parse(readFileSync(file, "utf8")).ideas.length, 3);
});

test("orchestrator saves a limited batch and preserves concurrent human edits", async () => {
  const root = fixture(), file = join(root, "sky.yaml");
  const entries = ["First", "Second", "Third"].map(text => ({ text, when: "2026-09-04T12:00:00Z", by: "person" }));
  const sky = { name: "test", stars: [{ name: "Inquiry", areas: [{ name: "research", open: entries }] }] };
  writeFileSync(file, stringify(sky));
  process.env.SKY_TEST_OUTPUT = JSON.stringify({ context: "Look in the research module", near: null, todo: "Investigate" });
  const pending = orchestrate(root, 2);
  writeFileSync(file, stringify({ ...sky, goal: "Human edit" }));
  const result = await pending; assert.equal(result.reached.length, 2);
  const updated = parse(readFileSync(file, "utf8"));
  assert.equal(updated.goal, "Human edit");
  assert.equal(updated.stars[0].areas[0].open.filter((i: any) => i.seen).length, 2);
  assert.equal(updated.stars[0].areas[0].todo.length, 2);
});

test("model failures do not leak raw CLI output", async () => {
  const root = fixture(); writeFileSync(process.env.SKY_CODEX!, '#!/usr/bin/env node\nconsole.error("PRIVATE TOKEN");process.exit(1)');
  await assert.rejects(callModel(root, "prompt"), error => error instanceof Error && !error.message.includes("PRIVATE TOKEN") && error.message.includes("failed"));
});
