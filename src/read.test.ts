import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSky, ringName } from "./read.ts";

test("activity artifacts locate ships without implying implementation or passing tests", () => {
  const root = mkdtempSync(join(tmpdir(), "sky-read-test-"));
  try {
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "work/reference.png"), Buffer.from([137, 80, 78, 71, 0, 255]));
    writeFileSync(join(root, "sky.yaml"), 'name: test\nstars:\n  - name: Graphics\n    areas:\n      - name: chart\n        files: []\n        activity: [work/*]\n');
    const area = readSky(root).stars[0].areas[0];
    assert.deepEqual(area.paths, ["work/reference.png"]);
    assert.equal(area.files, 0); assert.equal(area.lines, 0); assert.equal(area.ring, 0);
    assert.equal(ringName(3), "tests mapped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
