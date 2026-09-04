# Skylight

A project, drawn as a sky. The galaxy is the full view; a star system is an architecture department; a constellation is one feature.

Three north stars — the parts of your project — with their areas orbiting
them at how done they are. Closer in is more done. Agents are ships: idle ones
orbit the orange star in the middle, working ones are out at the area they are
touching. Ideas are loose stars you pin where you like.

Everything is read from the repository and from Claude Code's own transcripts.
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
| which ring an area orbits | no files → planned · thin → started · code → built · tests → tested · listed under `live` → live |
| done · to do · open · exploration | `sky.yaml`, plus `TODO` markers in code, plus unmerged branches |
| agents, and where they are | `~/.claude/projects/**/*.jsonl` — every Claude Code session that touched the repo |

## Plugging in your own orchestrator

The seam is the file. Skylight watches `sky.yaml` and redraws; anything that
reads and writes it is an orchestrator. The one shipped here
(`src/orchestrate.ts`) is the smallest true version — turn it off with
`SKY_NO_ORCHESTRATOR=1` and let yours take over. The contract:

| who | writes |
|---|---|
| a person, through the page | a star: `text`, `when`, `by: person`, `at` |
| the orchestrator | on that star: `seen`, `context`, `near` · new to-dos with `by: orchestrator`, `from` · questions, as `open` entries |
| skylight | nothing into the file — rings come from files and tests |
| nobody but a person | `live` |

Agents: Skylight finds Claude Code sessions by reading their transcripts. Any
other orchestrator can put its ships on the sky by reporting presence:

```bash
curl -X POST http://127.0.0.1:4340/api/presence \
  -H 'content-type: application/json' \
  -d '{"id":"worker-3","intent":"migrate the billing tables","file":"src/billing/schema.ts"}'
```

A report is good for ten minutes, then the ship goes idle; post `state: "gone"`
to take it off. The model calls in `gather.ts` and `orchestrate.ts` go
through the `claude` binary; swap them for whatever you use.

## The gesture

Click a system to open it. Click an area for its constellation. Double-click
empty sky to pin an idea where you clicked; in a constellation the place
decides what kind of star it is — above the alpha is to do, left is a
question, right an exploration, below is done. It is written straight into
`sky.yaml`.
