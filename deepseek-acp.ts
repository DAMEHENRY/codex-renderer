import { type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import { basename, extname } from "path";
import { createInterface } from "readline";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function imageBlock(file: string) {
  const mimeType = IMAGE_MIME_TYPES[extname(file).toLowerCase()];
  if (!mimeType) {
    throw new Error(`Unsupported DeepSeek attachment: ${basename(file)}. Use PNG, JPEG, WebP or GIF.`);
  }
  const bytes = await fs.readFile(file);
  return { type: "image", mimeType, data: bytes.toString("base64") };
}

/** Submit one image turn over the Harness ACP profile and flush the session before returning. */
export async function runHarnessImageTurn(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  sessionId: string | undefined,
  text: string,
  images: string[],
): Promise<{ sessionId: string; text: string }> {
  let nextId = 0;
  let pending: { id: number; resolve: (result: any) => void; reject: (error: Error) => void } | undefined;
  let closed = false;
  let reply = "";
  let activeSessionId: string | undefined;
  const lines = createInterface({ input: child.stdout });
  const fail = (error: Error) => {
    closed = true;
    pending?.reject(error);
    pending = undefined;
  };
  lines.once("close", () => fail(new Error("Harness image connection closed.")));
  child.once("error", fail);
  child.stdin.on("error", fail);

  function write(frame: object) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  }

  lines.on("line", (line) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object") return;
    if (event.method === "session/update" && event.params?.sessionId === activeSessionId) {
      const update = event.params.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        reply += update.content.text;
      }
    } else if (event.method && event.id !== undefined) {
      const response = event.method === "session/request_permission"
        ? { result: { outcome: { outcome: "cancelled" } } }
        : { error: { code: -32601, message: "Unsupported client request" } };
      write({ id: event.id, ...response });
    } else if (pending && pending.id === event.id) {
      const { resolve, reject } = pending;
      pending = undefined;
      if (event.error) reject(new Error(event.error.data?.message || event.error.message || "Harness request failed."));
      else resolve(event.result);
    }
  });

  function request(method: string, params: object): Promise<any> {
    if (closed) return Promise.reject(new Error("Harness image connection closed."));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending = { id, resolve, reject };
      write({ id, method, params });
    });
  }

  try {
    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (!initialized?.agentCapabilities?.promptCapabilities?.image) {
      throw new Error("The current Harness model does not accept image attachments.");
    }
    // Read every image before opening the session, so invalid inputs never submit a partial turn.
    const blocks = await Promise.all(images.map(imageBlock));
    const workspace = { cwd: await fs.realpath(cwd), mcpServers: [] };
    if (sessionId) {
      await request("session/resume", { sessionId, ...workspace });
    } else {
      const session = await request("session/new", workspace);
      sessionId = session?.sessionId;
    }
    if (!sessionId) throw new Error("Harness did not return a session ID.");
    activeSessionId = sessionId;
    const result = await request("session/prompt", {
      sessionId, prompt: [{ type: "text", text }, ...blocks],
    });
    await request("session/close", { sessionId });
    if (result?.stopReason !== "end_turn" || !reply.trim()) {
      throw new Error(`Harness did not finish the image turn (${result?.stopReason || "no reply"}).`);
    }
    return { sessionId, text: reply };
  } finally {
    child.stdin.end();
  }
}
