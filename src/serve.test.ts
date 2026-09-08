import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

test("HTTP stays responsive during planning and mapped monorepo files refresh", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "sky-server-test-"));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  mkdirSync(join(root, "apps"));
  writeFileSync(join(root, "apps/main.ts"), "one line\n");
  writeFileSync(join(root, "sky.yaml"), 'name: Test\nideas: [one, two]\nstars:\n  - name: Inquiry\n    areas:\n      - name: research\n        files: [apps/main.ts]\n');
  const cli = join(root, "fake-model.cjs");
  writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>{const fs=require("node:fs");fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message")+1],"[]")},600));');
  chmodSync(cli, 0o755);
  const child = spawn(process.execPath, ["--import", "tsx", "src/serve.ts", root], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), stdio: "pipe",
    env: { ...process.env, SKY_PORT: String(port), SKY_AGENT_SOURCES: "", SKY_NO_ORCHESTRATOR: "1", SKY_MODEL_PROVIDER: "codex", SKY_CODEX: cli },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let log = "";
      child.stdout.on("data", bytes => { log += bytes; if (log.includes("skylight  http")) resolve(); });
      child.on("error", reject); child.on("exit", code => reject(new Error(`server exited ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    let completed = false;
    const gathering = fetch(base + "/api/gather", { method: "POST" }).then(r => { completed = true; return r; });
    await delay(40);
    const sky = await (await fetch(base + "/api/sky")).json();
    assert.equal(sky.sky.name, "Test"); assert.equal(completed, false);
    assert.equal((await fetch(base + "/api/gather", { method: "POST" })).status, 409);
    assert.equal((await gathering).status, 200);
    writeFileSync(join(root, "apps/main.ts"), "line\n".repeat(90));
    let updated = false;
    for (let i = 0; i < 30; i++) {
      await delay(100);
      const data = await (await fetch(base + "/api/sky")).json();
      if (data.sky.stars[0].areas[0].lines >= 90) { updated = true; break; }
    }
    assert.ok(updated, "a mapped apps/ source change must refresh the sky");
  } finally {
    const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
    if (child.exitCode === null) { child.kill("SIGTERM"); await stopped; }
    rmSync(root, { recursive: true, force: true });
  }
});
