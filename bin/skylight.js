#!/usr/bin/env node
// skylight <path-to-repo>  — serves the sky for that repo on :4340
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const p = spawn(process.execPath, [join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(here, "..", "src", "serve.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
p.on("exit", (c) => process.exit(c ?? 0));
