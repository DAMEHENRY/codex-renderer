const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const esbuild = require("esbuild");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-renderer-rewind-test-"));
function bundle(name) {
  const output = path.join(temporary, `${name}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, `../${name}.ts`)], outfile: output, bundle: true, platform: "node", format: "cjs" });
  return require(output);
}
const { findRewindBoundary, getRewindDraft, verifyRewindFork } = bundle("rewind-logic");
const { forkBeforeMessage } = bundle("codex-session");
const message = (text, role = "user") => ({ role, content: text, displayContent: text, contextAttachments: [] });
const messages = [message("one 中"), message("reply", "assistant"), message("two"), message("reply2", "assistant"), message("three")];
const turn = (text, id) => ({ id, status: "completed", itemsView: "full", items: [{ type: "userMessage", content: [{ type: "text", text }] }] });
const turns = [turn("one 中", "turn-0"), turn("two", "turn-1"), turn("three", "turn-2")];
let checks = 0;
async function check(label, run) { await run(); checks++; console.log(`PASS: ${label}`); }
async function run(mode, index = 2, override = {}) {
  let child;
  try {
    return await forkBeforeMessage({
      executable: override.executable,
      env: { ...process.env, REWIND_TEST_MODE: mode },
      vaultRoot: temporary, sessionId: "source-id", messages, index,
      onSpawn: (process) => { child = process; }, timeoutMs: 3000, ...override,
    });
  } finally {
    if (child) assert.notEqual(child.exitCode === null && child.signalCode === null, true, "server must be fully stopped before releasing the operation");
  }
}

(async () => {
  // Exercise real child-process pipes on every platform without running Codex.
  const opts = {
    executable: process.execPath,
    createProcess: (_executable, args, options) => spawn(process.execPath, [path.join(__dirname, "fixtures/session-server.cjs"), ...args], options),
  };
  const rpc = (mode, index = 2, extra = {}) => run(mode, index, { ...opts, env: { ...process.env, REWIND_TEST_MODE: mode }, ...extra });
  await check("exact prompt boundary excludes the selected message", () => assert.equal(findRewindBoundary(messages, 2, turns), 1));
  await check("repeated text maps by order, not first text match", () => assert.equal(findRewindBoundary([message("same"), message("same")], 1, [turn("same", "a"), turn("same", "b")]), 1));
  await check("automatic turns remain before the selected user turn", () => assert.equal(findRewindBoundary(messages, 2, [turns[0], { id: "auto", status: "completed", itemsView: "full", items: [] }, ...turns.slice(1)]), 2));
  await check("stale cache fails instead of approximating", () => assert.throws(() => findRewindBoundary(messages, 2, [turn("other", "a"), ...turns]), /no longer matches/));
  await check("failed unaccepted messages cannot shift the boundary", () => assert.throws(() => findRewindBoundary(messages, 2, turns.slice(0, 1)), /not found/));
  await check("in-progress and partial history are rejected", () => {
    assert.throws(() => findRewindBoundary(messages, 2, [{ ...turns[0], status: "inProgress" }, turns[1]]), /finish/);
    assert.throws(() => findRewindBoundary(messages, 2, [{ ...turns[0], itemsView: "summary" }, turns[1]]), /complete/);
    assert.throws(() => findRewindBoundary(messages, 1, turns), /user message/);
  });
  await check("restores text and all context kinds without sharing references", () => {
    const chips = ["image", "file", "selection", "pdf-selection", "message-quote"].map(type => ({ type, label: type, sourcePath: "/tmp/context", data: "original" }));
    const original = { ...message("<context>\nfull prompt"), displayContent: "typed text", composerText: "typed text", contextAttachments: chips };
    const draft = getRewindDraft(original);
    assert.equal(draft.text, "typed text"); assert.deepEqual(draft.chips, chips);
    draft.chips[0].data = "edited"; assert.equal(chips[0].data, "original");
    assert.equal(getRewindDraft({ ...original, composerText: undefined }).text, "typed text");
    assert.equal(getRewindDraft({ ...original, composerText: undefined, displayContent: "[image attachment]" }).text, "");
  });
  await check("extra fork history is rejected", () => assert.throws(() => verifyRewindFork(turns.slice(0, 1), turns), /requested message/));
  await check("real subprocess transport handles paginated history and split Unicode", async () => assert.equal(await rpc("paginated"), "fork-id"));
  await check("legacy history uses full thread reads", async () => assert.equal(await rpc("legacy"), "fork-id"));
  await check("first message returns a fresh-session boundary", async () => assert.equal(await rpc("paginated", 0), null));
  await check("CLI ignoring fork boundary is rejected", async () => assert.rejects(rpc("ignored-boundary"), /requested message/));
  await check("another active process prevents forking", async () => assert.rejects(rpc("active"), /active in another/));
  await check("RPC failure propagates and stops the server", async () => assert.rejects(rpc("rpc-error"), /listing unavailable/));
  await check("timeout stops the server", async () => assert.rejects(rpc("timeout", 2, { timeoutMs: 100 }), /timed out/));
  await check("spawn failure does not hang", async () => assert.rejects(rpc("paginated", 2, { executable: path.join(temporary, "missing"), createProcess: undefined }), /ENOENT/));
  console.log(`${checks} rewind checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
