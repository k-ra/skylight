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

## 2026-09-08 · 10:15 · session with Kyra
Built: merged the work-computer branch (Codex activity, answered questions, reconcile). Ships now have a phase — working, waiting, done, failed — and a current, timestamped note. A ship whose turn ended with a question holds still with a blue light and appears in HQ as waiting on you, with what it asked. Presence accepts phase, note, task. Callsigns restored; the top-left project label removed (both Kyra's earlier calls).
Proof: typecheck ok · 17 tests pass (new tail.test.ts) · browser: a waiting ship at infra/store, HQ lists it with the note, the card opens and says to answer it in its terminal
Next: WORK_IN_PROGRESS.md step 2 — dispatch. Drag a ship from HQ onto a star to start a Claude Code run in a worktree with the star as its prompt, reporting phase through presence while it works; record the assignment and outcome on the star.
Ideas added: 3 design · 3 feature
