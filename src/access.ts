/**
 * Who may talk to this server. Ported from trellis.
 *
 * Skylight writes to sky.yaml and can call a model, so reachable and open are
 * not the same thing. By default it answers loopback only. A request from
 * anywhere else needs a key — SKY_SHARE_TOKEN — that exists only because
 * someone deliberately ran `npm run share`.
 *
 * The discriminator is not the socket address: a tunnel client runs on this
 * machine and connects over loopback like a browser does. What separates a
 * local browser from a forwarded request is the Host header, plus the hop
 * headers a proxy adds on the way through.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MIN_TOKEN_LENGTH = 16;
export const COOKIE = "skylight_share";
export const shareToken = (): string | null => { const t = process.env.SKY_SHARE_TOKEN?.trim(); return t && t.length >= MIN_TOKEN_LENGTH ? t : null; };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const HOP = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "cf-ray", "forwarded"];

export function isRemote(headers: Record<string, unknown>): boolean {
  for (const h of HOP) if (headers[h]) return true;
  const host = String(headers.host ?? "");
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return !LOOPBACK.has(name.toLowerCase());
}
export function keyMatches(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) { const eq = part.indexOf("="); if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim()); }
  return null;
}
const door = (message: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>skylight · key</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070b;color:#e2eaf4;font:14px/1.7 "IBM Plex Mono",ui-monospace,monospace;padding:24px}
form{display:grid;gap:14px;width:min(340px,100%)}h1{margin:0;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#8792a1;font-weight:500}p{margin:0;color:#8792a1}
input{border:0;border-bottom:1px solid rgba(226,234,244,.35);background:transparent;color:#e2eaf4;padding:8px 2px;font:inherit;outline:none;caret-color:#fff}button{border:1px solid rgba(255,107,59,.5);background:transparent;color:#ff6b3b;padding:9px 12px;font:inherit;letter-spacing:.12em;text-transform:uppercase;cursor:pointer}</style>
<form method="GET"><h1>skylight</h1><p>${message}</p><input name="k" type="password" autofocus autocomplete="off" placeholder="key"><button type="submit">open</button></form>`;

/** Returns true when the request was answered here (refused or redirected). */
export function gate(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isRemote(req.headers as Record<string, unknown>)) return false;
  const token = shareToken();
  if (!token) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("skylight is running, but only for this machine. Run `npm run share` there to open it, deliberately.\n"); return true; }
  const url = new URL(req.url ?? "/", "http://skylight.invalid");
  const k = url.searchParams.get("k");
  if (k !== null) {
    if (!keyMatches(k, token)) { res.writeHead(401, { "content-type": "text/html; charset=utf-8" }); res.end(door("That key was not right.")); return true; }
    const https = req.headers["x-forwarded-proto"] === "https"; url.searchParams.delete("k");
    res.writeHead(302, { "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${https ? "; Secure" : ""}`, location: url.pathname + url.search }); res.end(); return true;
  }
  const hdr = req.headers["x-skylight-key"];
  if (keyMatches(typeof hdr === "string" ? hdr : null, token) || keyMatches(cookieValue(req.headers.cookie, COOKIE), token)) return false;
  if ((req.url ?? "").startsWith("/api") || (req.url ?? "").startsWith("/events")) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "a key is required" })); return true; }
  res.writeHead(401, { "content-type": "text/html; charset=utf-8" }); res.end(door("This sky is shared. Paste the key from the link.")); return true;
}
