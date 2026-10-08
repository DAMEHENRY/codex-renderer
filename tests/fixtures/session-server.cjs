// Deterministic stdio app-server fixture; never touches real Codex state.
const readline = require("readline");
const mode = process.env.REWIND_TEST_MODE;
const turns = ["one 中", "two", "three"].map((text, i) => ({
  id: `turn-${i}`, status: "completed", itemsView: "full",
  items: [{ type: "userMessage", content: [{ type: "text", text }] }],
}));
let initialized = false;
let forked = false;
function reply(id, result) {
  const line = Buffer.from(JSON.stringify({ id, result }) + "\n");
  // Split in the middle of a multibyte Chinese character to exercise stream decoding.
  const split = line.indexOf(Buffer.from("中"));
  if (split >= 0) {
    process.stdout.write(line.subarray(0, split + 1));
    setTimeout(() => process.stdout.write(line.subarray(split + 1)), 5);
  } else process.stdout.write(line);
}
function error(id, message) { process.stdout.write(JSON.stringify({ id, error: { code: -32601, message } }) + "\n"); }
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (mode === "timeout") return;
  if (method === "initialize") {
    if (!params.capabilities.experimentalApi) return error(id, "experimental capability required");
    initialized = true;
    return reply(id, {});
  }
  if (method === "initialized") return;
  if (!initialized) return error(id, "initialize first");
  if (method === "thread/read") {
    return reply(id, { thread: {
      id: params.threadId, historyMode: mode === "legacy" ? "legacy" : "paginated",
      status: { type: mode === "active" ? "active" : "notLoaded" },
      turns: params.includeTurns ? (forked ? turns.slice(0, 1) : turns) : [],
    } });
  }
  if (method === "thread/turns/list") {
    if (mode === "rpc-error") return error(id, "listing unavailable");
    if (params.itemsView !== "full" || params.sortDirection !== "asc") return error(id, "full ascending history required");
    const data = forked && mode !== "ignored-boundary" ? turns.slice(0, 1) : turns;
    const start = params.cursor ? Number(params.cursor) : 0;
    return reply(id, { data: data.slice(start, start + 1), nextCursor: start + 1 < data.length ? String(start + 1) : null });
  }
  if (method === "thread/fork") {
    if (params.lastTurnId !== "turn-0" || !params.excludeTurns || !params.deferGoalContinuation) return error(id, "incorrect fork boundary");
    forked = true;
    return reply(id, { thread: { id: "fork-id" } });
  }
  error(id, `Unexpected method ${method}`);
});
