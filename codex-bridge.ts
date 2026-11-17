/**
 * codex-bridge.ts — Spawn and manage Codex CLI child processes.
 *
 * Uses child_process.spawn to run `codex exec --json` and parse JSONL output.
 * DeepSeek Harness owns its own fallback sessions. Both providers run as local CLIs.
 */

import { spawn, exec, ChildProcess } from "child_process";
import * as fs from "fs";
import { createInterface } from "readline";
import { runHarnessImageTurn } from "./deepseek-acp";
import { prepareHarnessArgs, parseHarnessFinal, isCodexConnectionFailure, type HarnessFinalEvent } from "./deepseek-harness";
import { forkBeforeMessage } from "./codex-session";
import { type RewindMessage } from "./rewind-logic";
import {
  buildCodexExecArgs,
  buildCodexChildPath,
  resolveExecutablePath,
  parseCodexJsonlLine,
  classifyFinalStatus,
  isThreadStoreConflict,
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
  deepSeekFallback?: boolean;
  deepSeekHarnessPath?: string;
}

export interface SendPromptOpts {
  prompt: string;
  sessionId?: string;   // undefined for new chat, UUID for resume
  imagePaths?: string[];
  deepSeekSession?: boolean;
  fallbackPrompt?: () => string;
  owner?: object;       // the chat pane; each pane may run one request at a time
}

export interface CodexStreamEvent {
  type: "thread_started" | "text" | "error" | "done" | "turn_completed" | "cancelled" | "status" | "busy";
  content: string;
  threadId?: string;
  deepSeek?: boolean;
  connectionFailure?: boolean;
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

/**
 * Running Codex children, keyed by the chat pane that owns them.
 * Each pane can run its own request; two panes may not write the same session.
 */
interface ActiveRun { child: ChildProcess; sessionId?: string; cancelled?: boolean }
const activeRuns = new Map<object, ActiveRun>();
const GLOBAL_OWNER = {};

function killChild(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000);
  child.once("close", () => clearTimeout(force));
}

/** Kill the process owned by `owner`, or every process when no owner is given. */
export function killCodexProcess(owner?: object): void {
  if (owner === undefined) {
    for (const run of activeRuns.values()) {
      run.cancelled = true;
      killChild(run.child);
    }
    return;
  }
  const run = activeRuns.get(owner);
  if (!run) return;
  run.cancelled = true;
  killChild(run.child);
}

/** True when `owner` has a running process, or any pane does when no owner is given. */
export function isCodexRunning(owner?: object): boolean {
  return owner === undefined ? activeRuns.size > 0 : activeRuns.has(owner);
}

function isSessionRunning(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  for (const run of activeRuns.values()) if (run.sessionId === sessionId) return true;
  return false;
}

export async function rewindConversation(
  codexCliPath: string, vaultRoot: string, sessionId: string,
  messages: RewindMessage[], index: number, owner: object = GLOBAL_OWNER,
): Promise<string | null> {
  if (activeRuns.has(owner) || isSessionRunning(sessionId)) {
    throw new Error("Wait for Codex to finish this conversation before rewinding.");
  }
  try {
    return await forkBeforeMessage({
      executable: resolveCodexPath(codexCliPath), env: buildCodexChildEnv(),
      vaultRoot, sessionId, messages, index,
      onSpawn: (child) => { activeRuns.set(owner, { child, sessionId }); },
    });
  } finally {
    activeRuns.delete(owner);
  }
}

/* ------------------------------------------------------------------ */
/*  Main send function                                                */
/* ------------------------------------------------------------------ */

/**
 * Spawn codex exec, write prompt to stdin, and yield parsed events.
 * Each owner may run one request at a time; different owners run in parallel.
 */
export async function* sendPrompt(
  settings: CodexBridgeSettings,
  opts: SendPromptOpts,
  vaultRoot: string,
): AsyncGenerator<CodexStreamEvent> {
  const owner = opts.owner ?? GLOBAL_OWNER;
  if (activeRuns.has(owner)) {
    yield { type: "busy", content: "Codex is still responding in this chat pane. Wait for its reply before retrying; this message was not sent." };
    yield { type: "done", content: "" };
    return;
  }
  if (isSessionRunning(opts.sessionId)) {
    yield { type: "busy", content: "This conversation is still running in another chat pane. Check its reply before retrying; this message was not sent." };
    yield { type: "done", content: "" };
    return;
  }

  if (opts.deepSeekSession) {
    yield* sendDeepSeekPrompt(settings, opts, vaultRoot, false);
    return;
  }

  const allowFallback = Boolean(settings.deepSeekFallback && settings.deepSeekHarnessPath);
  const diagnostics: CodexStreamEvent[] = [];
  for await (const event of sendCodexPrompt(settings, opts, vaultRoot, allowFallback)) {
    if (allowFallback && (event.type === "error" || event.type === "status")) {
      if (/^Reconnecting\.\.\./i.test(event.content)) {
        yield { type: "status", content: event.content.split(" (")[0] };
      } else {
        diagnostics.push(event);
      }
      continue;
    }
    if (event.connectionFailure) {
      for await (const fallbackEvent of sendDeepSeekPrompt(settings, opts, vaultRoot, true)) {
        if (fallbackEvent.type === "error") yield* diagnostics;
        yield fallbackEvent;
      }
      return;
    }
    if (event.type === "busy" || event.type === "cancelled") diagnostics.length = 0;
    if (event.type === "done" && !event.threadId) yield* diagnostics;
    yield event;
  }
}

async function* sendDeepSeekPrompt(
  settings: CodexBridgeSettings, opts: SendPromptOpts, vaultRoot: string, switching: boolean,
): AsyncGenerator<CodexStreamEvent> {
  const owner = opts.owner ?? GLOBAL_OWNER;
  try {
    if (!settings.deepSeekHarnessPath) throw new Error("DeepSeek Harness is unavailable on this computer.");
    const executable = settings.deepSeekHarnessPath;
    if (!fs.existsSync(executable)) throw new Error("DeepSeek Harness is unavailable on this computer.");
    const prompt = switching ? opts.fallbackPrompt?.() ?? opts.prompt : opts.prompt;
    const sessionId = switching ? undefined : opts.sessionId;
    const images = opts.imagePaths ?? [];
    const { args, cleanup, permission } = prepareHarnessArgs(settings.sandboxMode, sessionId, images.length > 0);
    try {
      const child = spawn(executable, args, {
        cwd: vaultRoot, env: { ...buildCodexChildEnv(), DSH_PERMISSION_MODE: permission }, stdio: ["pipe", "pipe", "pipe"],
      });
      const run: ActiveRun = { child, sessionId: opts.sessionId };
      activeRuns.set(owner, run);
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("close", resolve);
        child.once("error", reject);
      });
      // The consumer can close this generator after the status event.
      void closed.catch(() => {});

      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
      child.stdin.on("error", () => {}); // Early failures are reported by the child.
      const response = images.length
        ? runHarnessImageTurn(child, vaultRoot, sessionId, prompt, images)
        : (async () => {
            let final: HarnessFinalEvent | undefined;
            const lines = createInterface({ input: child.stdout });
            lines.on("line", (line) => { final = parseHarnessFinal(line) ?? final; });
            child.stdin.end(prompt);
            const exitCode = await closed;
            if (exitCode !== 0 || final?.reason.kind !== "completed" || !final.text.trim()) {
              throw new Error(final?.reason.error?.message || stderr.trim() || "No reply received.");
            }
            return final;
          })();
      // The process can fail during the status yield.
      void response.catch(() => {});

      let timedOut = false;
      const timeoutMs = settings.requestTimeoutMinutes * 60 * 1000;
      const timeout = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        killChild(child);
      }, timeoutMs) : undefined;
      try {
        yield {
          type: "status",
          content: switching ? "Codex connection failed. Trying DeepSeek Harness…" : "Thinking with DeepSeek Harness…",
        };
        let result;
        try {
          result = await response;
          const exitCode = await closed;
          if (exitCode !== 0) throw new Error(stderr.trim() || "Harness exited unexpectedly.");
        } catch (error) {
          if (!run.cancelled && !timedOut) throw error;
        }
        if (run.cancelled) {
          yield { type: "cancelled", content: "Request was cancelled." };
        } else if (timedOut) {
          throw new Error("Request timed out.");
        } else if (result) {
          if (!result.sessionId || (sessionId && result.sessionId !== sessionId)) {
            throw new Error("Harness returned an unexpected session ID.");
          }
          yield { type: "thread_started", content: "", threadId: result.sessionId, deepSeek: true };
          yield { type: "text", content: result.text };
        }
      } finally {
        clearTimeout(timeout);
        if (child.pid) killChild(child);
        await closed.catch(() => {});
        if (activeRuns.get(owner) === run) activeRuns.delete(owner);
      }
    } finally {
      cleanup();
    }
  } catch (error) {
    yield { type: "error", content: `DeepSeek Harness: ${error instanceof Error ? error.message : String(error)}` };
  }
  yield { type: "done", content: "" };
}

async function* sendCodexPrompt(
  settings: CodexBridgeSettings, opts: SendPromptOpts, vaultRoot: string, allowFallback: boolean,
): AsyncGenerator<CodexStreamEvent> {
  const owner = opts.owner ?? GLOBAL_OWNER;

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

  let child;
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

  const run: ActiveRun = { child, sessionId: opts.sessionId };
  activeRuns.set(owner, run);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdin.on("error", () => {}); // Early failures are reported by the child.
  child.stdin.end(opts.prompt);

  // Track state for final classification
  let threadId = "";
  let hasThreadStarted = false;
  let hasTurnCompleted = false;
  let hasError = false;
  let errorMessage = "";
  let timedOut = false;
  let spawnFailed = false;
  let codexStartedWork = false;
  let modelConnectionFailed = false;
  let finalUsage: CodexStreamEvent["usage"];

  // Timeout guard
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
  }

  // Collect stderr for error reporting
  let stderrBuf = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-32_768);
  });

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

  function processLine(line: string): void {
    const parsed = parseCodexJsonlLine(line);
    if (!parsed) return;
    if (parsed.type.startsWith("item.")) {
      const item = parsed.raw.item as { type?: string } | undefined;
      // Codex also emits diagnostic items during its own WebSocket-to-HTTPS retry.
      if (item?.type !== "error") codexStartedWork = true;
    }
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
        if (isCodexConnectionFailure(p.message)) modelConnectionFailed = true;
        if (!allowFallback || !/^Reconnecting\.\.\./i.test(p.message)) {
          hasError = true;
          errorMessage = p.message;
        }
        pushEvent({ type: "error", content: p.message });
        break;
      }

      // turn.started and other types: no-op
    }
  }

  const lines = createInterface({ input: child.stdout });
  lines.on("line", processLine);
  lines.on("close", () => {
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

  try {
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
    await closed;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (child.pid) killChild(child);
    await closed;
    if (activeRuns.get(owner) === run) activeRuns.delete(owner);
  }

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

  if (run.cancelled) {
    yield { type: "cancelled", content: "Request was cancelled." };
    yield { type: "done", content: "" };
    return;
  }

  if (isThreadStoreConflict(`${stderrBuf}\n${errorMessage}`)) {
    yield { type: "busy", content: "This conversation is active in another Codex process. Check its latest reply, then retry after it finishes; this message was not sent." };
    yield { type: "done", content: "" };
    return;
  }

  if (allowFallback && !codexStartedWork && !hasTurnCompleted &&
      status !== "success" && status !== "cancelled" && !spawnFailed &&
      modelConnectionFailed) {
    yield { type: "done", content: "", connectionFailure: true };
    return;
  }

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
