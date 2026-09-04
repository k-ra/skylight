/**
 * Open this sky to one other place for as long as this runs.
 *
 * The server still binds loopback; cloudflared dials out from here and hands
 * back a temporary https address. What crosses is gated by a key made fresh
 * for this run, so the link dies with ctrl-c and nothing needs undoing.
 *
 *   npm run share -- /path/to/repo
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? process.env.SKY_REPO ?? process.cwd());
const PORT = Number(process.env.SKY_PORT ?? 4340);
const TOKEN = process.env.SKY_SHARE_TOKEN ?? randomBytes(24).toString("base64url");
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const have = (bin: string) => new Promise<boolean>((ok) => { const p = spawn(bin, ["--version"], { stdio: "ignore" }); p.on("error", () => ok(false)); p.on("exit", (c) => ok(c === 0)); });

async function main() {
  if (!(await have("cloudflared"))) {
    process.stderr.write(`Sharing needs cloudflared, which is not installed.\n\n  mac      brew install cloudflared\n  windows  winget install Cloudflare.cloudflared\n  linux    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n\nIt dials out from this machine and hands back a temporary https address. Nothing is opened on your network; no account is involved.\n`);
    process.exit(1);
  }
  const server = spawn(process.execPath, [join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(HERE, "serve.ts"), REPO], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, SKY_SHARE_TOKEN: TOKEN, SKY_PORT: String(PORT) } });
  const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let said = false;
  const watch = (c: Buffer) => { const m = URL_RE.exec(c.toString()); if (!m || said) return; said = true;
    process.stdout.write(`\nthis sky is reachable from anywhere for as long as this runs\n\n  ${m[0]}/?k=${TOKEN}\n\n  repo   ${REPO}\n  key    in the link once, then in a cookie and out of the address bar\n  scope  anyone holding the link can place stars and run the orchestrator here — treat it as a password\n\nctrl-c to stop sharing. The address is not reusable afterwards.\n\n`); };
  tunnel.stdout.on("data", watch); tunnel.stderr.on("data", watch);
  const stop = () => { tunnel.kill("SIGTERM"); server.kill("SIGTERM"); process.exit(0); };
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, stop);
  tunnel.on("exit", (c) => { process.stderr.write(`\ncloudflared exited (${c}). The share is over.\n`); server.kill("SIGTERM"); process.exit(c ?? 0); });
  server.on("exit", (c) => { tunnel.kill("SIGTERM"); process.exit(c ?? 0); });
}
void main();
