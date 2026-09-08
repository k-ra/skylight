import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexTailer } from "./codex-tail.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sky-codex-test-")); dirs.push(dir);
  const root = join(dir, "project"), sessionsDir = join(dir, "sessions");
  mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(sessionsDir);
  writeFileSync(join(root, "src/main.ts"), "export const x = 1;");
  let now = Date.now();
  const event = (type: string, payload: object) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload }) + "\n";
  const file = join(sessionsDir, "rollout.jsonl");
  const meta = (cwd = root) => event("session_meta", { id: "thread-1", cwd, source: "vscode" });
  writeFileSync(file, meta());
  const tailer = new CodexTailer(root, () => {}, { sessionsDir, now: () => now });
  return { root, sessionsDir, file, event, meta, tailer, advance: (ms: number) => { now += ms; } };
}

test("tracks desktop Codex tool activity and completion without displaying tool output", () => {
  const f = fixture();
  appendFileSync(f.file, f.event("event_msg", { type: "task_started" }) +
    f.event("response_item", { type: "message", role: "user", content: [{ text: "Improve the project map" }] }) +
    f.event("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cat src/main.ts", workdir: f.root }) }) +
    f.event("response_item", { type: "function_call_output", output: "PRIVATE OUTPUT" }));
  f.tailer.poll();
  const agent = f.tailer.list()[0];
  assert.equal(agent.provider, "codex"); assert.equal(agent.state, "active");
  assert.equal(agent.lastFile, "src/main.ts"); assert.equal(agent.intent, "Improve the project map");
  assert.ok(!JSON.stringify(agent).includes("PRIVATE OUTPUT"));
  appendFileSync(f.file, f.event("event_msg", { type: "task_complete" })); f.tailer.poll();
  assert.equal(f.tailer.list()[0].state, "idle");
});

test("filters unrelated projects, handles partial JSON lines, and removes stale ships", () => {
  const f = fixture();
  writeFileSync(join(f.sessionsDir, "other.jsonl"), f.meta(f.root + "-other") + f.event("event_msg", { type: "task_started" }));
  const line = f.event("event_msg", { type: "task_started" });
  appendFileSync(f.file, line.slice(0, -2)); f.tailer.poll(); assert.equal(f.tailer.list().length, 0);
  appendFileSync(f.file, line.slice(-2)); f.tailer.poll(); assert.equal(f.tailer.list().length, 1);
  f.advance(11 * 60_000); f.tailer.poll(); assert.equal(f.tailer.list()[0].state, "unknown");
  f.advance(86_400_000); f.tailer.poll(); assert.equal(f.tailer.list().length, 0);
});

test("understands custom code tools and patch paths; rejects paths outside the project", () => {
  const f = fixture();
  appendFileSync(f.file, f.event("event_msg", { type: "task_started" }) +
    f.event("response_item", { type: "custom_tool_call", name: "exec", input: 'await tools.exec_command({cmd:"cat src/main.ts"});' }));
  f.tailer.poll(); assert.equal(f.tailer.list()[0].lastFile, "src/main.ts");
  appendFileSync(f.file, f.event("response_item", { type: "custom_tool_call", name: "apply_patch", input: "*** Update File: src/new file.ts\n@@\n" }) +
    f.event("response_item", { type: "function_call", name: "read_file", arguments: JSON.stringify({ file_path: "/private/unrelated.txt" }) }));
  f.tailer.poll(); assert.equal(f.tailer.list()[0].lastFile, "src/new file.ts");
});

test("maps a linked worktree into the same project's relative file paths", () => {
  const f = fixture(), worktree = join(f.root, "..", "linked");
  mkdirSync(worktree); writeFileSync(f.file, f.meta(worktree) + f.event("event_msg", { type: "task_started" }) +
    f.event("response_item", { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ path: join(worktree, "src/main.ts") }) }));
  const tailer = new CodexTailer(f.root, () => {}, { sessionsDir: f.sessionsDir, worktrees: [worktree] });
  tailer.poll(); assert.equal(tailer.list()[0].lastFile, "src/main.ts");
});

test("continues after malformed records and transcript truncation", () => {
  const f = fixture();
  appendFileSync(f.file, "{broken}\n" + f.event("event_msg", { type: "task_started" })); f.tailer.poll();
  assert.equal(f.tailer.list()[0].state, "active");
  writeFileSync(f.file, f.event("event_msg", { type: "task_complete" })); f.tailer.poll();
  assert.equal(f.tailer.list()[0].state, "idle");
});


test("recent tools establish activity even when the turn-start record is outside the history window", () => {
  const f = fixture();
  appendFileSync(f.file, f.event("response_item", { type: "function_call", name: "read_file", arguments: JSON.stringify({ path: "src/main.ts" }) }));
  f.tailer.poll();
  assert.equal(f.tailer.list()[0].state, "active");
});


test("excludes product sessions and internal helpers but retains delegated coding", () => {
  const f = fixture();
  const product = join(f.root, "work/duck/essay"); mkdirSync(product, { recursive: true });
  const started = f.event("event_msg", { type: "task_started" });
  writeFileSync(join(f.sessionsDir, "product.jsonl"), f.event("session_meta", { id:"product", cwd:product, source:"vscode" }) + started);
  writeFileSync(join(f.sessionsDir, "helper.jsonl"), f.event("session_meta", { id:"helper", cwd:f.root, source:{subagent:{other:"guardian"}} }) + started);
  writeFileSync(join(f.sessionsDir, "worker.jsonl"), f.event("session_meta", { id:"worker", cwd:f.root, source:{subagent:{thread_spawn:{parent_thread_id:"thread-1"}}} }) + started);
  // Similar prefixes are real code, not the excluded workspace.
  const near = join(f.root,"work/duck-tools"); mkdirSync(near,{recursive:true});
  writeFileSync(join(f.sessionsDir,"near.jsonl"), f.event("session_meta",{id:"near",cwd:near,source:"vscode"}) + started);
  appendFileSync(f.file, started);
  const tailer = new CodexTailer(f.root,()=>{}, {sessionsDir:f.sessionsDir,excludePaths:["work/duck"]});
  tailer.poll();
  assert.deepEqual(tailer.list().map(a=>a.id).sort(),["near","thread-1","worker"]);
});

test("discovers a moved task from explicit execution cwd, never from path mentions", () => {
  const f = fixture();
  writeFileSync(f.file, f.meta(join(f.root,'..','missing-old-folder')) + f.event('response_item', {type:'custom_tool_call',name:'exec',input:`await tools.exec_command({cmd:"ls",workdir:"${f.root}"});`}) + f.event('response_item',{type:'message',role:'assistant',content:[{text:'I am revising the authoring workflow.'}]}));
  f.tailer.poll();
  assert.equal(f.tailer.list().length,1);assert.equal(f.tailer.list()[0].lastTool,'exec_command');
  assert.equal(f.tailer.list()[0].note,'I am revising the authoring workflow.');
  writeFileSync(join(f.sessionsDir,'unrelated.jsonl'), f.event('session_meta',{id:'unrelated',cwd:join(f.root,'..','other-missing')}) + f.event('response_item',{type:'message',role:'user',content:[{text:`Please read ${f.root}`}]}) + f.event('event_msg',{type:'task_started'}));
  f.advance(16000);f.tailer.poll();assert.equal(f.tailer.list().length,1);
});

test("reconsiders excluded tasks when new execution context arrives", () => {
 const f=fixture();writeFileSync(f.file,f.meta(join(f.root,'..','old-missing')));f.tailer.poll();assert.equal(f.tailer.list().length,0);
 appendFileSync(f.file,f.event('turn_context',{cwd:f.root}) + f.event('event_msg',{type:'task_started'}));
 f.advance(16000);f.tailer.poll();assert.equal(f.tailer.list().length,1);
});
