import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { initSky, starterSky } from "./init.ts";

test("a starter sky uses the project name and an existing source directory", () => {
  const root = mkdtempSync(join(tmpdir(), "skylight-init-"));
  mkdirSync(join(root, "src"));
  const sky = parse(starterSky(root));
  assert.equal(sky.name, basename(root));
  assert.deepEqual(sky.stars[0].areas[0].files, ["src/**/*"]);
});

test("init writes one editable manifest and never overwrites it", () => {
  const root = mkdtempSync(join(tmpdir(), "skylight-init-"));
  const file = initSky(root);
  const first = readFileSync(file, "utf8");
  assert.match(first, /goal: what is this project for\?/);
  writeFileSync(file, `${first}# mine\n`);
  assert.throws(() => initSky(root), /already exists/);
  assert.match(readFileSync(file, "utf8"), /# mine/);
});
