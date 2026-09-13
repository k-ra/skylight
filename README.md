# Skylight

draw your project like a sky! define a north star, hurl smaller tasks as stars into the world, and monitor agent behavior as a spaceship task force. early local prototype.

skylight reads the repository and local Claude Code and Codex activity. one file, `sky.yaml`, serves as the spec and PRD. the rest is derived from files, tests, branches, TODOs, and agents at work.

the visual logic:

- HQ tracks actionable items, eval results, and new changes to approve
- comets and flying stars track ambient agent activity
- constellations are feature maps
- star systems are parts of the project architecture
- loose stars are ideas you can pin where you like

requires Node 22 or newer and a git repository with a `sky.yaml`.

```bash
git clone https://github.com/k-ra/skylight.git
cd skylight
npm install
npm run init -- /path/to/your/project
npm start -- /path/to/your/project
```

open `http://127.0.0.1:4340`. `npm run export` keeps a still sky as `snapshot.html`.
