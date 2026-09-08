# Journal

One entry per working session, newest first. Written by whoever worked: a person, or the scheduled run.

Format:

```
## 2026-09-08 · 02:10 · scheduled
Built: <one line — what now works that did not>
Proof: <typecheck ok · screenshot · what was clicked>
Next: <the one thing the next session should pick up>
Ideas added: <n design · n feature>
```

---

## 2026-09-08 · 11:10 · session with Kyra
Built: step 3, evidence — when a ship comes back, the project's own tests run on its branch and the result is written on the run (`tests: pass | fail | none | timeout`, with counts read from node / jest / vitest / pytest reporters and the reporter's last line). The card says "82 tests hold" or "3 fail", accept reads "accept anyway" on a failing branch, the star wears a solid ring when tests hold and a broken orange one when they fail, news rides a meteor, "check again" re-runs it. And a second way of seeing a star: the orbit view — press v or ◎ in a constellation — the same tilted disc a star system is, with the work on rings: done closest in, then to do, questions, explorations. Double-clicking a ring places that kind of star. Remembered per browser.
Proof: typecheck ok · 20 tests (the fake ship's project now has tests that pass on the first pass and fail after the revision, and the run records both) · real: evidence re-run on trellis's Placeholder tests branch through the new /api/retest.
Next: step 4 — what matters next: a way to see priority and blockage without reading the YAML (dependencies between stars; "blocked on" as a line). Also: callsign collisions; HQ words colliding with system labels behind while a level fades; the returned-ship glyph and the evidence ring compete at small sizes in the orbit view.
Ideas added: none — reserved at Kyra's request.

## 2026-09-08 · 10:55 · session with Kyra
Built: dispatch — the loop's step 2. Click a to-do, question, or exploration in a constellation and send a ship: a git worktree on a branch named after the star, Claude Code in print mode with the star as its task, its stream feeding the ship on the sky (what it says, what it touches). It comes back with a postcard (did / doubted / untouched) recorded on the star as `run:`, waits in HQ under accept · revise; accept merges and moves the star to done with `landed` and `proof`; revise resumes the same session on the same branch with a note; recall stops it. A restart marks ships that were out as failed. Worktrees get the project's node_modules linked so ships can run tests.
Proof: typecheck ok · 19 tests (dispatch.test.ts runs a fake ship through send → done → revise → accept) · a real ship sent from the sky on trellis/render "Placeholder tests": back in four minutes with six tests that hold (ran them in its worktree). Its branch sky/render-placeholder-tests-5353 waits for Kyra to press accept — a person lands it, not this session.
Next: step 3, evidence — when a ship comes back, run the project's tests on its branch and show pass/fail on the card and the star, so accepting is a look at evidence, not a postcard. Then: callsign collisions (two ships were both "capella"); the HQ words colliding with system labels behind while a level fades.
Ideas added: none — reserved for later at Kyra's request.

## 2026-09-08 · 10:15 · session with Kyra
Built: merged the work-computer branch (Codex activity, answered questions, reconcile). Ships now have a phase — working, waiting, done, failed — and a current, timestamped note. A ship whose turn ended with a question holds still with a blue light and appears in HQ as waiting on you, with what it asked. Presence accepts phase, note, task. Callsigns restored; the top-left project label removed (both Kyra's earlier calls).
Proof: typecheck ok · 17 tests pass (new tail.test.ts) · browser: a waiting ship at infra/store, HQ lists it with the note, the card opens and says to answer it in its terminal
Next: WORK_IN_PROGRESS.md step 2 — dispatch. Drag a ship from HQ onto a star to start a Claude Code run in a worktree with the star as its prompt, reporting phase through presence while it works; record the assignment and outcome on the star.
Ideas added: 3 design · 3 feature
