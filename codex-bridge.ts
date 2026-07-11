/**
 * codex-bridge.ts — Spawn and manage Codex CLI child processes.
 *
 * Uses child_process.spawn to run `codex exec --json` and parse JSONL output.
 * No direct API calls. Official Codex CLI owns all session/state files.
 */

import { spawn, exec, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  buildCodexExecArgs,
  buildCodexChildPath,
  resolveExecutablePath,
  parseCodexJsonlLine,
  classifyFinalStatus,
  parseModelsJson,
  type ParsedCodexEvent,
  type FinalStatus,
  type ThreadStartedEvent,
  type ItemCompletedEvent,
  type TurnCompletedEvent,
  type ErrorEvent,
  type ModelCatalogEntry,
} from "./session-logic";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface CodexBridgeSettings {
  codexCliPath: string;
  modelPresets: string[];
  selectedModel: string;
  reasoningEffort: string;
  webSearchMode: string;
  sandboxMode: string;
  approvalPolicy: string;
  requestTimeoutMinutes: number;
}

export interface SendPromptOpts {
  prompt: string;
  sessionId?: string;   // undefined for new chat, UUID for resume
  imagePaths?: string[];
}

export interface CodexStreamEvent {
  type: "thread_started" | "text" | "error" | "done" | "turn_completed" | "cancelled" | "status";
  content: string;
  threadId?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

export type SendStatus =
  | "idle"
  | "success"
  | "cancelled"
  | "timeout"
  | "spawn-error"
  | "process-error"
  | "error"
  | "no-result";

/* ------------------------------------------------------------------ */
/*  CLI discovery                                                     */
/* ------------------------------------------------------------------ */

export function buildCodexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: buildCodexChildPath(env.PATH || ""),
  };
}

export function resolveCodexPath(configuredPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const childEnv = buildCodexChildEnv(env);
  const result = resolveExecutablePath(configuredPath, childEnv.PATH || "", (candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (result.path) return result.path;
  throw new Error(`Codex CLI not found. Checked: ${result.candidates.join(", ")}`);
}

/* ------------------------------------------------------------------ */
/*  Process management                                                */
/* ------------------------------------------------------------------ */

let activeChild: ChildProcess | null = null;

export function killCodexProcess(): void {
  if (!activeChild) return;
  try {
    activeChild.kill("SIGTERM");
  } catch {
    // ignore
  }
  // Force kill after 3 seconds if still alive
  const child = activeChild;
  setTimeout(() => {
    try {
      if (child && !child.killed) child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 3000);
  activeChild = null;
}

export function isCodexRunning(): boolean {
  return activeChild !== null;
}

/* ------------------------------------------------------------------ */
/*  Main send function                                                */
/* ------------------------------------------------------------------ */

/**
 * Spawn codex exec, write prompt to stdin, and yield parsed events.
 * Caller is responsible for only calling once at a time.
 */
export async function* sendPrompt(
  settings: CodexBridgeSettings,
  opts: SendPromptOpts,
  vaultRoot: string,
): AsyncGenerator<CodexStreamEvent> {
  let codexPath: string;
  try {
    codexPath = resolveCodexPath(settings.codexCliPath);
  } catch (err) {
    yield { type: "error", content: err instanceof Error ? err.message : String(err) };
    yield { type: "done", content: "" };
    return;
  }
  const args = buildCodexExecArgs({
    vaultRoot,
    sessionId: opts.sessionId,
    model: settings.selectedModel,
    reasoningEffort: settings.reasoningEffort,
    webSearchMode: settings.webSearchMode,
    sandboxMode: settings.sandboxMode,
    approvalPolicy: settings.approvalPolicy,
    imagePaths: opts.imagePaths,
  });

  const timeoutMs = settings.requestTimeoutMinutes * 60 * 1000;

  let child: ChildProcess;
  try {
    child = spawn(codexPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: vaultRoot,
      env: buildCodexChildEnv(),
    });
  } catch (err) {
    yield {
      type: "error",
      content: `Failed to spawn Codex CLI: ${err instanceof Error ? err.message : String(err)}`,
    };
    yield { type: "done", content: "" };
    return;
  }

  activeChild = child;

  // Write prompt to stdin and close
  try {
    child.stdin?.write(opts.prompt);
    child.stdin?.end();
  } catch (err) {
    yield {
      type: "error",
      content: `Failed to write to Codex stdin: ${err instanceof Error ? err.message : String(err)}`,
    };
    killCodexProcess();
    yield { type: "done", content: "" };
    return;
  }

  // Track state for final classification
  let threadId = "";
  let hasThreadStarted = false;
  let hasTurnCompleted = false;
  let hasError = false;
  let errorMessage = "";
  let timedOut = false;
  let spawnFailed = false;
  let finalUsage: CodexStreamEvent["usage"];

  // Timeout guard
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killCodexProcess();
    }, timeoutMs);
  }

  // Collect stderr for error reporting
  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  // Parse stdout JSONL line by line
  let lineBuf = "";
  const stdout = child.stdout;

  if (!stdout) {
    yield { type: "error", content: "No stdout from Codex CLI" };
    yield { type: "done", content: "" };
    activeChild = null;
    return;
  }

  // We need to yield events as they arrive from stdout.
  // Use a queue-based approach with a generator.
  const eventQueue: CodexStreamEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let streamDone = false;

  function pushEvent(evt: CodexStreamEvent) {
    eventQueue.push(evt);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  }

  stdout.on("data", (chunk: Buffer) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() || "";

    for (const line of lines) {
      const parsed = parseCodexJsonlLine(line);
      if (!parsed) continue;

      switch (parsed.type) {
        case "thread.started": {
          const p = parsed as ThreadStartedEvent;
          threadId = p.threadId;
          hasThreadStarted = true;
          pushEvent({ type: "thread_started", content: "", threadId });
          break;
        }

        case "item.completed": {
          const p = parsed as ItemCompletedEvent;
          if (p.itemType === "agent_message" && p.text) {
            pushEvent({ type: "text", content: p.text });
          }
          break;
        }

        case "turn.completed": {
          const p = parsed as TurnCompletedEvent;
          hasTurnCompleted = true;
          finalUsage = p.usage;
          pushEvent({
            type: "turn_completed",
            content: "",
            usage: p.usage,
          });
          break;
        }

        case "error":
        case "turn.failed": {
          const p = parsed as ErrorEvent;
          hasError = true;
          errorMessage = p.message;
          pushEvent({ type: "error", content: p.message });
          break;
        }

        // turn.started and other types: no-op
      }
    }
  });

  stdout.on("end", () => {
    // Process any remaining data in lineBuf
    if (lineBuf.trim()) {
      const parsed = parseCodexJsonlLine(lineBuf);
      if (parsed) {
        if (parsed.type === "thread.started") {
          const p = parsed as ThreadStartedEvent;
          threadId = p.threadId;
          hasThreadStarted = true;
          pushEvent({ type: "thread_started", content: "", threadId: p.threadId });
        } else if (parsed.type === "item.completed") {
          const p = parsed as ItemCompletedEvent;
          if (p.itemType === "agent_message" && p.text) {
            pushEvent({ type: "text", content: p.text });
          }
        } else if (parsed.type === "turn.completed") {
          const p = parsed as TurnCompletedEvent;
          hasTurnCompleted = true;
          finalUsage = p.usage;
          pushEvent({ type: "turn_completed", content: "", usage: p.usage });
        } else if (parsed.type === "error" || parsed.type === "turn.failed") {
          const p = parsed as ErrorEvent;
          hasError = true;
          errorMessage = p.message;
          pushEvent({ type: "error", content: p.message });
        }
      }
    }
    streamDone = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });

  child.on("error", (err) => {
    spawnFailed = true;
    hasError = true;
    errorMessage = err.message;
    pushEvent({
      type: "error",
      content: `Codex CLI spawn error: ${err.message}`,
    });
    streamDone = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });

  // Yield events as they arrive
  while (true) {
    if (eventQueue.length > 0) {
      const evt = eventQueue.shift()!;
      yield evt;
      if (evt.type === "done") return;
    } else if (streamDone) {
      break;
    } else {
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  }

  // Wait for process to exit
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    // If already exited, resolve immediately
    if (child.exitCode !== null || child.killed) resolve();
  });

  if (timeoutHandle) clearTimeout(timeoutHandle);
  activeChild = null;

  // Yield final status
  const status: FinalStatus = classifyFinalStatus({
    exitCode: child.exitCode,
    signal: child.signalCode ?? null,
    hasThreadStarted,
    hasTurnCompleted,
    hasError,
    errorMessage,
    timedOut,
    spawnFailed,
  });

  if (stderrBuf.trim() && status !== "success" && status !== "cancelled") {
    yield { type: "status", content: `stderr: ${stderrBuf.trim().slice(0, 500)}` };
  }

  if (status === "success") {
    yield { type: "done", content: "", threadId: threadId || undefined, usage: finalUsage };
  } else if (status === "cancelled") {
    yield { type: "cancelled", content: "Request was cancelled." };
    yield { type: "done", content: "" };
  } else {
    if (!hasError) {
      yield {
        type: "error",
        content: `Codex CLI ${status}: ${errorMessage || stderrBuf.trim().slice(0, 300) || "unknown error"}`,
      };
    }
    yield { type: "done", content: "" };
  }
}

/**
 * Fetch model catalog from Codex CLI.
 * Runs `codex debug models` and falls back to `codex debug models --bundled` on error.
 */
export function fetchModelCatalog(codexCliPath: string): Promise<ModelCatalogEntry[]> {
  return new Promise((resolve) => {
    let binPath: string;
    try {
      binPath = resolveCodexPath(codexCliPath);
    } catch {
      resolve([]);
      return;
    }
    const execOptions = { env: buildCodexChildEnv() };
    exec(`"${binPath}" debug models`, execOptions, (err, stdout) => {
      if (err) {
        // Fallback to bundled
        exec(`"${binPath}" debug models --bundled`, execOptions, (err2, stdout2) => {
          if (err2) {
            resolve([]);
          } else {
            resolve(parseModelsJson(stdout2));
          }
        });
      } else {
        const parsed = parseModelsJson(stdout);
        if (parsed.length === 0) {
          // Fallback if parsing returned empty
          exec(`"${binPath}" debug models --bundled`, execOptions, (err2, stdout2) => {
            if (err2) {
              resolve([]);
            } else {
              resolve(parseModelsJson(stdout2));
            }
          });
        } else {
          resolve(parsed);
        }
      }
    });
  });
}
