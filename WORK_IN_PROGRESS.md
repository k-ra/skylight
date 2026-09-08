# Skylight — work in progress

Updated 2026-09-08. This describes the current prototype and proposed next work;
it is not a claim that the full experience has been accepted.

## Vision

Understand and direct a project through a sky: systems describe major product
capabilities, constellations describe features, ships show agents at work, and
loose stars capture ideas. The map should help a person decide what to do next.

## What exists

- Galaxy, system and constellation navigation; spatial placement of ideas,
  to-dos, questions, explorations and done items into `sky.yaml`.
- Repository-derived file/test indicators, TODOs and branch explorations;
  human-controlled `live` declarations.
- Claude and Codex activity adapters, explicit `/api/presence` reports,
  project/worktree scoping, activity history and observed tool/file details.
- Disconnected activity is marked unknown instead of remaining visibly active.
- Model-assisted grouping and annotation. Answered questions can receive
  proposed consequences; a person accepts or rejects them. Accept destinations
  can follow the project's own schema through `accept_into`.
- Asynchronous planning with protection against overwriting concurrent manifest
  edits, plus local viewing, snapshot export and optional sharing.

Since this audit, dispatch, recall, revision, human acceptance and returned test
evidence have landed. Task placement now uses explicit assignment or conservative
objective matching, and activity shows the objective separately from recent
messages and tools. Moved Codex tasks can be rediscovered from execution context.
These are implemented building blocks; a complete real-user workflow still needs
validation. Dispatch currently uses Claude Code; a Codex dispatch adapter remains
open. The checklist below records the intended experience, not wholly absent code.

## Next: finish one complete work loop

Proposed sequence: place an idea → review the proposed work → assign it → follow
progress → inspect the result → accept or request revision.

1. **Make activity understandable and trustworthy.** Give each ship a stable
   task identity and a current, timestamped description. Distinguish working,
   waiting for input, completed, failed and unknown. Link to the relevant task
   and its result where supported. Saved labels and last-mentioned files must
   not masquerade as current intent or ongoing edits.
   **Check:** follow two simultaneous tasks, finish one, interrupt another and
   disconnect the viewer; each remains distinguishable and accurately labeled.

2. **Connect approved work to execution.** Choose and implement an explicit
   dispatch integration. Record the assignment, worker/task ID and outcome;
   make retries and reconnects safe against duplicate dispatch. Keep annotation
   separate from authorization to start coding.
   **Check:** an approved idea produces exactly one inspectable assignment and
   returns a result to that same idea, including failure or revision requests.

3. **Ground completion in evidence.** Rings currently use file presence, line
   counts and mapped test declarations. Add relevant test results, artifacts
   and review evidence without turning those proxies into a quality score.
   Preserve the person's final acceptance decision.
   **Check:** an area with many lines or failing tests cannot appear accepted
   solely because source and test declarations exist.

4. **Make the map useful as the spec grows.** Decide which goals, priorities,
   dependencies, acceptance criteria and open decisions should be visible.
   Improve labels and information density through actual use; keep project
   vocabulary configurable rather than requiring a particular product schema.
   **Check:** a person can identify what matters next, why it is blocked and
   what would count as done without reading the full YAML file.

## Reliability and validation still needed

- Exercise a complete browser workflow, including question acceptance/rejection,
  live activity, disconnect/reconnect and result inspection.
- Verify viewer startup and recovery across terminal closure and app restarts.
- Test activity capture against current real session formats, long histories,
  delegated workers and linked worktrees. The bounded transcript adapter is
  best effort; remote workers need an explicit reporting connection.
- Update documentation where behavior has evolved: stale Codex activity becomes
  unknown, and saved task labels are distinct from current observed activity.
- Revalidate export and optional sharing with the new fields and interactions.
  Review which project and activity information a shared sky exposes.

Existing automated tests cover selected adapter, planning, manifest and server
behaviors. They do not establish visual quality or validate the complete loop.
The objective-placement update adds regression coverage for stable placement,
ambiguous objectives, prompt steering, moved tasks and task discovery before file
activity. Visual and real-user acceptance remain open.

## Suggested next milestone

Demonstrate one real idea becoming an assigned task, a visible result and a
human decision in the same sky. Record what the person could understand and
control, then use that evidence to choose the next feature.
