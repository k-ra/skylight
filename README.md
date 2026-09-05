# Skylight

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
to take it off. Set `SKY_MODEL_PROVIDER=codex` to use Codex for planning, or `claude` (the default) for Claude Code.

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
