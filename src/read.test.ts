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

test("an answered question stays open until it is explicitly reconciled", () => {
  const root = mkdtempSync(join(tmpdir(), "sky-answer-test-"));
  try {
    writeFileSync(join(root, "sky.yaml"), [
      "name: test",
      "stars:",
      "  - name: Agent",
      "    areas:",
      "      - name: graphics",
      "        files: []",
      "        open:",
      "          - text: Quality bar | what counts as a graphic failure?",
      "            answer: overengineering as a crutch for unclear reasoning",
      "            by: person",
      "            when: 2026-09-04T21:19:46.766Z",
      "          - text: Style systems | how much should a theme control?",
      "            answer: palette and type only",
      "            by: person",
      "            when: 2026-09-04T21:20:00.000Z",
      "            reconciled: 2026-09-04T23:40:00.000Z",
      "",
    ].join("\n"));

    const items = readSky(root).stars[0].areas[0].items;
    const answered = items.find((i) => i.text === "Quality bar");
    const settled = items.find((i) => i.text === "Style systems");

    // An answer must not complete the question. It stays open, carrying the
    // answer, so it can still be found and acted on.
    assert.equal(answered?.kind, "open");
    assert.equal(answered?.more, "overengineering as a crutch for unclear reasoning");
    assert.equal(answered?.src, "answered · not yet reconciled");

    // Only explicit reconciliation closes it.
    assert.equal(settled?.kind, "done");
    assert.equal(settled?.src, "reconciled");
    assert.equal(settled?.reconciled, "2026-09-04T23:40:00.000Z");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
