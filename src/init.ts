import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stringify } from "yaml";

export function starterSky(root: string): string {
  const source = ["src", "app", "apps", "packages"].find((dir) => existsSync(join(root, dir)));
  const files = source ? [`${source}/**/*`] : ["**/*.{ts,tsx,js,jsx,html,css,py,rs,go,swift}"];
  return stringify({
    name: basename(root),
    goal: "what is this project for?",
    stars: [{
      name: "product",
      goal: "the main thing",
      areas: [{
        name: "first area",
        about: "what belongs here?",
        files,
        tests: ["**/*.test.*", "**/*.spec.*"],
        done: [],
        todo: [],
        open: [],
        explore: [],
      }],
    }],
    ideas: [],
  });
}

export function initSky(target: string): string {
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  const file = join(root, "sky.yaml");
  if (existsSync(file)) throw new Error(`sky.yaml already exists in ${root}`);
  writeFileSync(file, starterSky(root), { flag: "wx" });
  return file;
}

if (process.argv[1]?.endsWith("init.ts")) {
  try {
    const file = initSky(process.argv[2] ?? process.cwd());
    process.stdout.write(`wrote ${file}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
