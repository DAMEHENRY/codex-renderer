import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { StringDecoder } from "string_decoder";
import { findRewindBoundary, verifyRewindFork, type RewindMessage, type StoredTurn } from "./rewind-logic";

/** Short-lived official app-server connection. Never edits Codex's files directly. */
class SessionClient {
  private nextId = 0;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private stderr = "";
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private timer: ReturnType<typeof setTimeout>;
  private closed: Promise<void>;
  private stopped = false;

  constructor(readonly child: ChildProcess, timeoutMs: number) {
    this.closed = new Promise((resolve) => {
      child.once("close", () => {
        this.stopped = true;
        this.fail(new Error(`Codex session connection closed. ${this.stderr.trim().slice(-500)}`));
        resolve();
      });
    });
    child.once("error", (error) => this.fail(error));
    child.stdin?.on("error", (error) => this.fail(error));
    child.stderr?.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method && message.id !== undefined) {
          // Rewind has no model turn; reject unexpected server requests instead of hanging.
          this.write({ id: message.id, error: { code: -32601, message: "Unsupported during rewind" } });
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "Codex session request failed"));
        else waiter.resolve(message.result);
      }
    });
    this.timer = setTimeout(() => {
      this.fail(new Error("Codex rewind timed out. The original chat is unchanged."));
      child.kill("SIGTERM");
    }, timeoutMs);
  }

  private fail(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private write(message: object): void {
    if (this.stopped || this.child.stdin?.destroyed) throw new Error("Codex session connection is closed.");
    this.child.stdin!.write(JSON.stringify(message) + "\n");
  }

  request(method: string, params: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "codex_renderer", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
  }

  async readTurns(threadId: string): Promise<StoredTurn[]> {
    const { thread } = await this.request("thread/read", { threadId, includeTurns: false });
    if (thread.status?.type === "active") throw new Error("This conversation is active in another Codex process. Wait for it to finish before rewinding.");
    if (thread.historyMode !== "paginated") {
      const full = await this.request("thread/read", { threadId, includeTurns: true });
      if (!Array.isArray(full.thread?.turns)) throw new Error("Codex did not return turn history.");
      return full.thread.turns;
    }
    const turns: StoredTurn[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "asc", itemsView: "full" });
      if (!Array.isArray(page.data)) throw new Error("Codex did not return turn history.");
      turns.push(...page.data);
      cursor = page.nextCursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Codex returned a repeated history cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return turns;
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const force = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    this.child.kill("SIGTERM");
    await this.closed;
    clearTimeout(force);
  }
}

export async function forkBeforeMessage(opts: {
  executable: string;
  env: NodeJS.ProcessEnv;
  vaultRoot: string;
  sessionId: string;
  messages: RewindMessage[];
  index: number;
  onSpawn: (child: ChildProcess) => void;
  timeoutMs?: number;
  createProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
}): Promise<string | null> {
  const child = (opts.createProcess || spawn)(opts.executable, ["app-server", "--stdio"], {
    cwd: opts.vaultRoot, env: opts.env, stdio: ["pipe", "pipe", "pipe"],
  });
  opts.onSpawn(child);
  const client = new SessionClient(child, opts.timeoutMs ?? 30000);
  try {
    await client.initialize();
    const turns = await client.readTurns(opts.sessionId);
    const boundary = findRewindBoundary(opts.messages, opts.index, turns);
    // No retained turn: the next send starts a fresh official session.
    if (boundary === 0) return null;
    const result = await client.request("thread/fork", {
      threadId: opts.sessionId,
      lastTurnId: turns[boundary - 1].id,
      cwd: opts.vaultRoot,
      excludeTurns: true,
      deferGoalContinuation: true,
    });
    const forkId = result.thread?.id;
    if (typeof forkId !== "string" || !forkId || forkId === opts.sessionId) throw new Error("Codex did not create a separate rewind branch.");
    const forkTurns = await client.readTurns(forkId);
    verifyRewindFork(turns.slice(0, boundary), forkTurns);
    return forkId;
  } finally {
    await client.close();
  }
}
