/** Model-backed planning through the user's existing CLI login. */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ModelProvider = "claude" | "codex";
export function modelProvider(): ModelProvider {
  const value = process.env.SKY_MODEL_PROVIDER ?? "claude";
  if (value !== "claude" && value !== "codex") throw new Error("SKY_MODEL_PROVIDER must be claude or codex");
  return value;
}

function binary(root: string, provider: ModelProvider): string {
  if (provider === "codex") return process.env.SKY_CODEX ?? process.env.CODEX_BIN ?? "codex";
  if (process.env.SKY_CLAUDE) return process.env.SKY_CLAUDE;
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
    for (const base of [root, process.cwd()]) {
      const candidate = join(base, "node_modules", "@anthropic-ai", `claude-agent-sdk-${platform}`, "claude");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "claude";
}

/** the Claude Code binary this machine has, for ships */
export const claudeBinary = (root: string): string => binary(root, "claude");

export async function callModel(root: string, prompt: string): Promise<string> {
  const provider = modelProvider();
  const dir = mkdtempSync(join(tmpdir(), "skylight-model-"));
  const output = join(dir, "answer.txt");
  const args = provider === "codex"
    ? ["exec", "--ephemeral", "--sandbox", "read-only", "-C", root, "--output-last-message", output, "-"]
    : ["-p", "--output-format", "text"];
  const env = { ...process.env };
  // Preserve the existing CLI account unless the user explicitly supplies a key.
  if (provider === "claude" && process.env.SKY_API_KEY) env.ANTHROPIC_API_KEY = process.env.SKY_API_KEY;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(binary(root, provider), args, {
        cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout) => {
        if (error) {
          // Never return CLI stderr or the prompt through the browser API.
          const reason = (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `not found; set SKY_${provider.toUpperCase()} to its executable`
            : error.killed ? "timed out" : "failed; check the CLI login and configuration";
          reject(new Error(`${provider} ${reason}`));
        } else resolve(stdout);
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end("Use only the supplied information. Return the requested JSON. Do not run tools or change files.\n\n" + prompt);
    });
    return provider === "codex" ? readFileSync(output, "utf8") : stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
