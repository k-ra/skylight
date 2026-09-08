import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { setTimeout as delay } from "node:timers/promises";
import { Dispatcher } from "./dispatch.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A pretend Claude Code in print mode: streams events, edits the file it was told about, commits, and answers with a postcard. */
const FAKE_SHIP = `#!/usr/bin/env node
const fs = require("node:fs"), cp = require("node:child_process");
const args = process.argv.slice(2), prompt = args[args.indexOf("-p") + 1], resumed = args.includes("--resume");
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
say({ type: "system", subtype: "init", session_id: resumed ? args[args.indexOf("--resume") + 1] : "sess-" + Date.now() });
say({ type: "assistant", message: { content: [{ type: "text", text: "Reading the feature." }] } });
say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: process.cwd() + "/src/a.ts" } }] } });
fs.appendFileSync("src/a.ts", resumed ? "export const revised = true;\\n" : "export const b = 2;\\n");
cp.execFileSync("git", ["add", "-A"]); cp.execFileSync("git", ["-c", "user.name=ship", "-c", "user.email=ship@sky", "commit", "-q", "-m", resumed ? "Revised" : "Added b"]);
const postcard = (resumed ? "did: revised as asked" : "did: added b") + "\\ndoubted: whether a.ts was the right file\\nuntouched: the tests";
say({ type: "assistant", message: { content: [{ type: "text", text: postcard }] } });
say({ type: "result", subtype: "success", is_error: false, result: postcard });
`;

test("a ship goes out to a star, comes back with a postcard, is revised, and lands when accepted", { timeout: 20_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sky-dispatch-")), root = join(tmp, "repo"), home = join(tmp, "worktrees");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "sky.yaml"), `name: Test\ngoal: a test\nstars:\n  - name: core\n    areas:\n      - name: numbers\n        about: small numbers\n        files: [src/a.ts]\n        done: [ "a | the first one" ]\n        todo:\n          - Add b | the second one\n          - text: Add c\n            when: 2026-09-08T00:00:00Z\n            by: person\n`);
  git(root, "init", "-q", "-b", "main"); git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "start");
  const ship = join(tmp, "ship.cjs"); writeFileSync(ship, FAKE_SHIP); chmodSync(ship, 0o755);
  const sky = () => parse(readFileSync(join(root, "sky.yaml"), "utf8"));
  const runOf = () => sky().stars[0].areas[0].todo?.find((t: any) => t?.text === "Add b")?.run;
  const settle = async (want: string) => { for (let i = 0; i < 100; i++) { if (runOf()?.status === want) return; await delay(100); } assert.fail(`run never became ${want}: ${JSON.stringify(runOf())}`); };

  let changes = 0;
  const d = new Dispatcher(root, { onChange: () => changes++ }, { bin: ship, home, env: { ...process.env, PATH: process.env.PATH } });
  try {
    assert.equal(d.accept("numbers", "Add b"), "no ship was sent to that star");
    const sent = d.send("numbers", "Add b");
    assert.equal(sent.error, undefined);
    assert.equal(runOf().status, "running");
    assert.equal(d.send("numbers", "Add b").error, "a ship is already on it");
    assert.equal(d.agents()[0].star, "Add b");
    assert.equal(d.agents()[0].phase, "working");

    await settle("done");
    const run = runOf();
    assert.match(run.said, /^did: added b/);
    assert.equal(run.files, 1);
    assert.ok(run.session, "the session id is kept so the ship can be sent back");
    assert.equal(d.agents()[0].phase, "done");
    assert.equal(d.agents()[0].state, "idle");
    assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "export const a = 1;\n", "main is untouched until a person accepts");
    assert.ok(changes > 2, "the sky was told as things happened");

    // revise: the same ship, same branch, resumed session
    const again = d.send("numbers", "Add b", "call it beta");
    assert.equal(again.error, undefined);
    assert.equal(runOf().note, "call it beta");
    await settle("done");
    assert.match(runOf().said, /^did: revised/);
    assert.equal(runOf().files, 1, "still one file, two commits");

    // accept: merged, moved to done with proof, worktree gone
    assert.equal(d.accept("numbers", "Add b"), null);
    const after = sky().stars[0].areas[0];
    assert.equal(after.todo.length, 1, "the other to-do stays");
    assert.equal(after.todo[0].text, "Add c");
    const landed = after.done.find((x: any) => x?.text === "Add b");
    assert.ok(landed); assert.equal(landed.by, "person"); assert.match(landed.proof, /^merged sky\//); assert.equal(landed.run.status, "accepted");
    assert.equal(landed.more, "the second one", "the long half of the line survives");
    assert.match(readFileSync(join(root, "src/a.ts"), "utf8"), /revised = true/);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.ok(!existsSync(join(home, ...[])) || !git(root, "worktree", "list").includes(home), "the worktree is removed after landing");
    assert.equal(d.accept("numbers", "Add b"), "no such star");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("without git there is no ship, said plainly", () => {
  const root = mkdtempSync(join(tmpdir(), "sky-nogit-"));
  writeFileSync(join(root, "sky.yaml"), "name: x\nstars:\n  - name: s\n    areas:\n      - name: a\n        todo: [ do it ]\n");
  try {
    const d = new Dispatcher(root, { onChange: () => {} }, { bin: "/nonexistent", home: join(root, "wt") });
    assert.match(d.send("a", "do it").error ?? "", /needs a git repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
