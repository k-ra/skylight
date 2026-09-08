# Ideas

The packet. Two lists: **design directions** and **features**. Each scheduled session reads this, picks
one thing worth an evening, builds it, and adds a few new ideas of its own at the bottom of each list.

Status marks: `·` open · `→` being built · `✓` shipped (write the date) · `✗` vetoed by Kyra (keep the line, say why).

The bar for a feature: **0 → 1, creative, not analog.** Think about how people use @grok on X: an agent
you summon *where the conversation already is*, that answers in public, in one line, and that other
people can see happen. Skylight's version of that is an agent you summon *where the work already is*
— a commit, a code comment, a screenshot, a link — and whose answer is drawn, not typed.

Vetoed for good (do not re-propose): time scrubbing / looking backwards · naming finished
constellations · commit or test counts as progress · alphanumeric ids in the UI · absolute local
paths in the UI · sentences where a mark will do.

---

## Design directions

- `·` **Bloom, properly.** Render stars to an offscreen canvas, blur, add back. Real glow instead of
  radial gradients. Cheap, and it is the thing the current sky most visibly lacks.
- `·` **Parallax depth.** Three star layers moving at different rates on pan and on the slow rotation,
  so the disc reads as a volume. Still 2D canvas.
- `·` **The orrery (3D).** three.js: systems as inclined orbital planes, camera dollies into a
  constellation on click, points with depth of field. Build as `explorations/orrery.html` first, on
  real `/api/sky` data, and put it beside the 2D sky before proposing a switch. The risk is
  readability of labels; the win is the zoom.
- `·` **Shader stars.** WebGL point sprites, twinkle in the fragment shader. Ten thousand stars for
  free, which matters the moment a sky has fifty constellations.
- `·` **Planetarium mode.** No chrome, no cursor, the day's dawn cycle tied to the real clock, meant
  for a second monitor or an office wall. `?planetarium=1`.
- `·` **Engraved chart.** A second theme: sepia paper, engraved lines, gridlines and declination
  marks, like a 1700s star atlas. The clay-tablet idea, done as a print. Themes are a switch, not
  a fork.
- `·` **Terminal sky.** `npx skylight --tui`: the same sky as text in the terminal, beside the agents
  that are working. Braille dots for stars, one line per ship.
- `·` **Sound, off by default.** A quiet tone per meteor, a chord when a star is lit. Setting.
- `·` **The poster.** Export the sky as a single SVG made for a pen plotter: the project at v1.0,
  printed.
- `·` **Phone HQ.** The HQ queue as a thumb-first page — proposals, questions, light-it — for
  answering from the sofa through the share link.
- `·` **Weather as cost.** Haze density over a system = spend this usage window. Setting, off by
  default. Never a number on the sky itself.

## Features

- `·` **Summon.** `@sky` anywhere the work is — a code comment (`// @sky is this the right file?`),
  a commit message, a PR comment — becomes a star in the right constellation, with `from:` pointing
  at the line. The orchestrator reaches for it like any other star. This is the grokbot move.
- `·` **Ask the sky.** One text line at the bottom: *what is closest to live?* · *what is waiting on
  me?* · *who is at the billing tables?* Answered from sky.yaml + git, and drawn as a lit path on the
  sky, not as a paragraph.
- `·` **Screenshot → star.** Paste a bug screenshot or a Figma frame onto the sky. The model names
  the constellation it belongs to and writes the to-do with the image attached as `more`.
- `·` **Link → star.** Paste a tweet, a GitHub issue, a Discord message. It becomes an idea star with
  the link kept; gather clusters it with the rest.
- `·` **Start a sky from a paragraph.** Drop a PRD, a Notion export, or three sentences into an empty
  folder and get a first `sky.yaml` proposed: stars, areas, files guessed from the tree. The 0→1
  moment for a new project.
- `·` **Dispatch.** Drag a ship from HQ onto a star: a Claude Code run starts in a worktree with the
  star as its prompt. Presence puts the ship on the sky while it works. The first act of steering.
- `·` **Postcards.** A finished agent run leaves three lines on its star: what it did, what it
  doubted, what it did not touch. Not a log; a postcard.
- `·` **Conflict comets.** Two ships at the same file: a comet crosses between them. Click it to see
  the overlapping hunks. Only drawn when it is true.
- `·` **What changed since I last looked.** Per-viewer last-seen; new stars glow; meteors replay the
  news in order when you arrive.
- `·` **The dawn report.** When the queue empties and dawn comes, the sky writes five lines — landed,
  waiting, stuck — ready to paste into Slack. Written once, at dawn, never on demand.
- `·` **Public sky.** `npm run share --public`: a read-only sky as a living roadmap for an open-source
  repo. Put the link in the README instead of a ROADMAP.md nobody updates.
- `·` **Open stars.** Mark a star *anyone*; contributors claim it by putting their ship on it through
  presence. Bounties without a marketplace.
- `·` **Nova.** When a person lights a star, everyone on the share link sees it at the same moment.
  Shared, small, and true.
- `·` **Branch overlay.** Pick a branch or worktree and see, faintly, which stars it would move and
  where. Helps decide what to merge first.
- `·` **Hold to talk.** Hold space, speak, release: the transcript becomes the star under the cursor.
- `·` **Sky for a week.** A shareable snapshot that expires in seven days, for a design review or a
  demo, with local placing turned off.

---

## Added by sessions

Append here, dated, with the same marks. Keep each line to two sentences.
