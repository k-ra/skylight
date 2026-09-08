# Skylight

Current prototype status and remaining work: [WORK_IN_PROGRESS.md](WORK_IN_PROGRESS.md).

A project, drawn as a sky. The galaxy is the full view; a star system is a major part of the product; a constellation is one feature.

Three north stars — the parts of your project — with their areas orbiting
them at how done they are. Closer in is more done. Agents are ships: idle ones
orbit the orange star in the middle, working ones are out at the area they are
touching. Ideas are loose stars you pin where you like.

Everything is read from the repository and from local Claude Code and Codex activity.
One file is written by a person — `sky.yaml` — and it names the stars, the
areas, and which files belong to each. Everything else derives.

## Run it

```bash
npm install
npm start -- /path/to/your/repo      # the repo must hold a sky.yaml
```

Open http://127.0.0.1:4340. `npm run export` writes a standalone `snapshot.html`.

## Reach it from anywhere

By default Skylight answers only this machine. To open it deliberately, for
as long as one command runs:

```bash
brew install cloudflared     # once (winget install Cloudflare.cloudflared on Windows)
npm run share -- /path/to/your/repo
```

That prints an `https://…trycloudflare.com/?k=…` link. The key rides in the
address once, then moves into a cookie. Every star you place through that link
lands in `sky.yaml` on the machine running it, and the orchestrator reaches for
it. Anyone holding the link can do the same — treat it as a password. The
address dies when you stop.

## sky.yaml

```yaml
name: trellis
goal: one sentence — what the whole thing is for

live:              # areas a person has confirmed are tested and live
  - lint

ideas:             # loose stars
  - A bookshelf of every version

stars:
  - name: frontend
    areas:
      - name: canvas
        about: One surface, laid out by the system.
        files: [src/web/src/canvas.tsx]
        tests: [test/canvas.test.ts]
        activity: [work/canvas/**] # optional artifacts: place ships without counting source lines
        done:  [ "Frameless cards | a screen just exists on the canvas" ]
        todo:  [ "Layout tests" ]
        open:  [ "Keep the history view?" ]
        explore: [ "Not taken · one unified canvas" ]
```

`"Short | the longer line"` — the short half sits on the star, the long half
shows on hover.

## What is derived

| on screen | from |
|---|---|
| which ring an area orbits | no files → planned · thin → started · code → built · test declarations → tests mapped · listed under `live` → live |
| done · to do · open · exploration | `sky.yaml`, plus `TODO` markers in code, plus unmerged branches |
| agents, and where they are | Local Claude Code transcripts and project-scoped Codex sessions; explicit presence reports also work |

## Plugging in your own orchestrator

The seam is the file. Skylight watches `sky.yaml` and redraws; anything that
reads and writes it is an orchestrator. The one shipped here
(`src/orchestrate.ts`) is the smallest true version — turn it off with
`SKY_NO_ORCHESTRATOR=1` and let yours take over. The contract:

| who | writes |
|---|---|
| a person, through the page | a star: `text`, `when`, `by: person`, `at` |
| the orchestrator | on that star: `seen`, `context`, `near` · new to-dos with `by: orchestrator`, `from` · questions, as `open` entries · on an **answered** question: `addresses_question`, `restates`, and `proposes[]` with `by: orchestrator` |
| nobody but a person | `live`, and `reconciled` — answering a question does not close it |
| skylight | nothing into the file — rings come from files and tests |

Where an accepted line lands is yours to say: set `accept_into:` on an area or at the
top of `sky.yaml` (Facet points it at `spec.acceptance`). With nothing configured, an
area that already keeps a `spec` map gets `spec.acceptance` and everything else gets
`accepted:` — no project schema required. The path is never taken from the model.

Agents: Skylight finds Claude Code and Codex sessions locally. Any
other orchestrator can put its ships on the sky by reporting presence:

```bash
curl -X POST http://127.0.0.1:4340/api/presence \
  -H 'content-type: application/json' \
  -d '{"id":"worker-3","intent":"migrate the billing tables","file":"src/billing/schema.ts"}'
```

A report is good for ten minutes, then the ship goes idle; post `state: "gone"`
to take it off. A ship can also say what phase it is in and what it last said:

```bash
curl -X POST http://127.0.0.1:4340/api/presence \
  -H 'content-type: application/json' \
  -d '{"id":"worker-3","phase":"waiting","note":"Drop the old index, or keep it for the audit log?","task":"HUNT-42"}'
```

| phase | on the sky |
|---|---|
| `working` | the ship moves, with a trail |
| `waiting` | the ship holds still with a blue light, and HQ lists it as waiting on you, with the note |
| `done` · `failed` | the ship comes home; `failed` rides across the sky as news |

Claude Code sessions get their phase from their transcripts without reporting
anything: a turn that ends in words and no tool call is a ship waiting for you. Set `SKY_MODEL_PROVIDER=codex` to use Codex for planning, or `claude` (the default) for Claude Code.

## Sending a ship

In a constellation, click a to-do, a question, or an exploration and choose
**send a ship**. Skylight makes a git worktree on a branch named after the
star, runs Claude Code there in print mode with the star as its task, and
draws the ship circling the star while it works — what it is saying, what it
is touching. When it is done it leaves a postcard on the star:

```
did: …        doubted: …        untouched: …
```

and the star waits in HQ under **accept · revise**. Accept merges the branch
and moves the star to `done` with `landed` and `proof: merged sky/…`. Revise
sends the same ship back with your note, resuming its session on the same
branch. Recall stops it. Nothing is merged, and nothing is marked done, unless
you say so. The record lives on the star:

```yaml
todo:
  - text: Placeholder tests
    run: { id: ship-…, branch: sky/render-placeholder-tests-3f2a, status: done,
           when: …, ended: …, said: "did: …", files: 2, session: …, by: person }
```

**Evidence.** When a ship comes back, Skylight runs the project's own tests on
its branch (`npm test`, five-minute limit) and writes the result on the run:

```yaml
    tests: { status: pass, pass: 82, fail: 0, at: … }     # or fail · none · timeout
```

The card says *82 tests hold* or *3 fail* with the reporter's last line, the
star wears a solid ring when they hold and a broken orange one when they do
not, and the accept button reads *accept anyway* on a failing branch. It is
pass or fail, never a score; the person still decides. *Check again* re-runs
it. `SKY_SHIP_TESTS=0` turns it off.

Ships may edit files and run `git add/commit/status/diff/log`, `npm test`,
`npm run`, `npx`, `node`, `ls`, `cat`, `grep`. Set `SKY_SHIP_TOOLS` to a
comma-separated list of Claude Code tool patterns to change that. Worktrees
live under `~/.skylight/worktrees/`; a project that is not a git repository
cannot send ships. If Skylight restarts while a ship is out, the run is marked
failed rather than left looking alive.

## Two ways of seeing a star

A constellation is a chart: its stars joined into a figure, with what a person
placed reaching from the star it belongs beside. Press `v` (or the ◎ in the
bar) and the same star is seen as **orbits**: a slowly turning disc with its
work on rings — done closest in, then to do, then questions, then explorations
at the edge. Distance is state, as it is for a star system. Double-click on a
ring to place a star of that kind. The choice is remembered in the browser.

## The gesture

Click a system to open it. Click an area for its constellation. Double-click
empty sky to pin an idea where you clicked; in a constellation the place
decides what kind of star it is — above the alpha is to do, left is a
question, right an exploration, below is done. It is written straight into
`sky.yaml`.

## Codex on your Mac

```sh
SKY_MODEL_PROVIDER=codex SKY_AGENT_SOURCES=codex npm start -- /path/to/project
```

The project needs a `sky.yaml`. Choose systems around product capabilities or the
user journey, then assign concrete files and tests to each area. Put specific
features inside those systems; multiple implementations may contribute to one
feature. Optional `activity` globs associate generated artifacts or reference images
with an area without counting them as implementation or tests. The first matching area owns a file's ship placement. Monorepo folders
such as `apps/`, `packages/`, and `skills/` are watched automatically when mapped.

Activity and planning are independent:

- **Activity:** recent Codex sessions under `$CODEX_HOME/sessions` (normally
  `~/.codex/sessions`) appear automatically when their working directory belongs
  to the project or one of its linked Git worktrees. Desktop and CLI sessions
  using this local format are supported. Completed turns go idle; stale activity
  goes idle after ten minutes and disappears after a day. Ships identify their
  provider. Session files are read locally; raw tool output is not served.
- **Planning:** Gather and the background annotator invoke `codex exec` with the
  existing CLI login, configured default model, an ephemeral session, and a
  read-only sandbox. Skylight applies the returned annotations to `sky.yaml`.
  Set `SKY_CODEX` (or `CODEX_BIN`) for a custom executable. No new API key is needed.
  Claude remains available through `SKY_CLAUDE` and the existing CLI login.

Use `SKY_AGENT_SOURCES=claude,codex` (the default) for both activity sources.
An empty value disables transcript discovery; explicit presence reports still
work. `SKY_NO_ORCHESTRATOR=1` disables automatic annotation, while the explicit
Gather action remains available. Only a person marks an area `live`.

Codex's on-disk transcript format is a best-effort adapter, not a stable public
API. Discovery runs every 15 seconds and reads bounded chunks; large sessions
can take several polls to catch up. Historical activity beyond the initial
2 MiB tail is omitted. Sessions on another machine are not visible locally.
For integrations independent of the transcript format, use `/api/presence` or
adapt the documented [Codex JSON event stream](https://developers.openai.com/codex/noninteractive/).

Planning requests run asynchronously so the page stays responsive. They merge
results into the latest manifest rather than overwriting edits made while the
model is running. A changed set of loose ideas requires gathering again.

The rings are implementation clues, not release certification: line counts and
mapped test declarations do not prove correctness. Review tests yourself before
marking anything live.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests use disposable session files and fake model executables; they do not make
model calls or read your personal transcripts.
