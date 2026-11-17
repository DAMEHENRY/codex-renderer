import * as fs from "fs";
import { tmpdir } from "os";
import * as path from "path";

export const DEEPSEEK_MODEL = "deepseek-flash";
export const DEEPSEEK_HARNESS_PATH = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";

const ACP_PATCH = `- id: acp
  inject:
    - acpAppStartup
  config:
    provider: deepseek-account
    model: ${DEEPSEEK_MODEL}
- id: approval
  config:
    policy: never
`;

const ACCOUNT_PATCH = `- id: authorization
  disabled: false
- id: credentials
  disabled: false
- id: deepseek-account
  disabled: false
- id: agent-default-model
  config:
    provider: deepseek-account
    model: ${DEEPSEEK_MODEL}
`;

export function prepareHarnessArgs(sandboxMode: string, sessionId?: string, withImages = false) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "codex-renderer-deepseek-"));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const patch = path.join(directory, "account.yml");
    fs.writeFileSync(patch, withImages ? ACP_PATCH : ACCOUNT_PATCH, { mode: 0o600 });
    const permission = ["workspace-write", "danger-full-access"].includes(sandboxMode) ? sandboxMode : "read-only";
    if (withImages) return { args: ["acp", "--patch", patch], cleanup, permission };
    const args = ["headless", "--patch", patch, "--json", "--permission-mode", permission, "--approval-policy", "never"];
    if (sessionId) args.push("--session-id", sessionId);
    args.push("-");
    return { args, cleanup, permission };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export interface HarnessFinalEvent {
  type: "final";
  sessionId: string;
  text: string;
  reason: { kind: string; error?: { message?: string } };
}

export function parseHarnessFinal(line: string): HarnessFinalEvent | undefined {
  try {
    const value = JSON.parse(line);
    if (value?.type === "final" && typeof value.sessionId === "string" &&
        typeof value.text === "string" && typeof value.reason?.kind === "string") {
      return value;
    }
  } catch {
    // Ignore diagnostics mixed into stdout.
  }
}

export function isCodexConnectionFailure(output: string): boolean {
  return /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND)\b|dns (?:error|lookup failed)|(?:failed|unable) to (?:connect|resolve host)|connection (?:reset|refused|timed out|closed before)|network is unreachable|error sending request for url|stream disconnected before completion|workspace routing discovery failed|websocket (?:error|handshake failed)|\b(?:50[234])\s+(?:bad gateway|service unavailable|gateway timeout)\b/i.test(output);
}

export function buildHarnessHandoff(
  messages: { role: string; displayContent: string; sendStatus: string }[],
  prompt: string,
): string {
  const pairs: string[] = [];
  let remaining = 24_000;
  for (let index = messages.length - 1; index > 0; index--) {
    const reply = messages[index];
    const question = messages[index - 1];
    if (reply.role !== "assistant" || reply.sendStatus !== "success" || question.role !== "user") continue;
    const pair = JSON.stringify([
      { role: "user", text: question.displayContent },
      { role: "assistant", text: reply.displayContent },
    ]);
    if (pair.length > remaining) break;
    remaining -= pair.length;
    pairs.unshift(pair);
    index--;
  }
  return pairs.length
    ? `Earlier conversation for reference (quoted turns, followed by the current request):\n${pairs.join("\n")}\n\nCurrent request:\n${prompt}`
    : prompt;
}
