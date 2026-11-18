const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-renderer-fallback-test-"));
function bundle(name) {
  const outfile = path.join(temporary, `${name}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, `../${name}.ts`)], outfile, bundle: true, platform: "node", format: "cjs" });
  return require(outfile);
}

const { sendPrompt, killCodexProcess, isCodexRunning } = bundle("codex-bridge");
const { buildHarnessHandoff, isCodexUsageLimitFailure, DEEPSEEK_HARNESS_PATH } = bundle("deepseek-harness");
const codex = path.join(temporary, "codex");
const harness = path.join(temporary, "dsh");
const emit = (event) => `console.log(${JSON.stringify(JSON.stringify(event))});`;
const thread = emit({ type: "thread.started", thread_id: "codex-thread" });
const offline = "workspace routing discovery failed";
const retry = emit({ type: "error", message: `Reconnecting... 5/5 (${offline})` });
const diagnostic = emit({ type: "item.completed", item: { type: "error", message: "Falling back from WebSockets to HTTPS transport." } });
const failure = (message) => emit({ type: "turn.failed", error: { message } });
const tool = emit({ type: "item.started", item: { type: "command_execution" } });
const success = [
  emit({ type: "item.completed", item: { type: "agent_message", text: "Codex reply" } }),
  emit({ type: "turn.completed" }),
];
const settings = {
  codexCliPath: codex, modelPresets: [], selectedModel: "", reasoningEffort: "",
  webSearchMode: "off", sandboxMode: "read-only", approvalPolicy: "never", requestTimeoutMinutes: 1,
  deepSeekFallback: true, deepSeekHarnessPath: harness,
};

function writeExecutable(file, code) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${code}\n`, { mode: 0o700 });
}

async function collect(options = {}, overrides = {}, onEvent = () => {}) {
  const owner = {};
  const events = [];
  for await (const event of sendPrompt({ ...settings, ...overrides }, { prompt: "hello", owner, ...options }, temporary)) {
    events.push(event);
    onEvent(event, owner);
  }
  assert.equal(isCodexRunning(owner), false);
  return events;
}

(async () => {
  // Real PNG content for protocol and optional live vision tests.
  const imagePath = path.join(temporary, "sample.png");
  fs.writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAVElEQVR4nO3PMQ0AMAgAME7OCcG/KEwwCVx8TWqg8bpORc4tAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHNB3bFaQD6JDXcAAAAAElFTkSuQmCC", "base64"));
  writeExecutable(harness, `
    const args = process.argv.slice(2);
    if (args[0] === "acp") {
      const readline = require("node:readline");
      readline.createInterface({input: process.stdin}).on("line", line => {
        const { id, method, params } = JSON.parse(line);
        let result = {};
        if (method === "initialize") result = {agentCapabilities: {promptCapabilities: {image: true}}};
        if (method === "session/new") result = {sessionId: "session-image"};
        if (method === "session/prompt") {
          const [text, image] = params.prompt;
          if (text.type !== "text" || image.type !== "image" || image.mimeType !== "image/png" ||
              Buffer.from(image.data, "base64").subarray(1, 4).toString() !== "PNG") process.exit(1);
          console.log(JSON.stringify({method: "session/update", params: {
            sessionId: params.sessionId, update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: text.text}}
          }}));
          result = {stopReason: "end_turn"};
        }
        console.log(JSON.stringify({id, result}));
      });
      return;
    }
    const sessionIndex = args.indexOf("--session-id");
    let text = "";
    process.stdin.setEncoding("utf8").on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => console.log(JSON.stringify({
      type: "final", sessionId: sessionIndex < 0 ? "session-fallback" : args[sessionIndex + 1],
      reason: { kind: "completed" }, text
    })));
  `);
  const handoff = buildHarnessHandoff([
    { role: "user", displayContent: "earlier question", sendStatus: "success" },
    { role: "assistant", displayContent: "earlier answer", sendStatus: "success" },
    { role: "user", displayContent: "failed question", sendStatus: "error" },
    { role: "assistant", displayContent: "failed answer", sendStatus: "error" },
  ], "new request");
  assert.match(handoff, /earlier answer[\s\S]*Current request:\nnew request/);
  assert.doesNotMatch(handoff, /failed question|failed answer/);

  writeExecutable(codex, [thread, retry, diagnostic, failure(offline), "process.exitCode = 1;"].join("\n"));
  const switched = await collect({ sessionId: "codex-thread", fallbackPrompt: () => handoff });
  assert.equal(switched.filter(e => e.deepSeek).length, 1);
  assert.equal(switched.find(e => e.deepSeek).threadId, "session-fallback");
  assert.equal(switched.find(e => e.type === "text").content, handoff);
  assert.equal(switched.some(e => e.type === "error"), false);
  assert.equal((await collect({ sessionId: "session-fallback", deepSeekSession: true })).find(e => e.deepSeek).threadId, "session-fallback");

  const imageTurn = await collect({ imagePaths: [imagePath], fallbackPrompt: () => handoff });
  assert.equal(imageTurn.find(e => e.deepSeek)?.threadId, "session-image");
  assert.equal(imageTurn.find(e => e.type === "text")?.content, handoff);
  const imageResume = await collect({ sessionId: "session-fallback", deepSeekSession: true, imagePaths: [imagePath] });
  assert.equal(imageResume.find(e => e.deepSeek)?.threadId, "session-fallback");

  const unsupported = await collect({ imagePaths: ["/image.svg"] });
  assert(unsupported.some(e => e.type === "error" && /Unsupported DeepSeek attachment/.test(e.content)));
  assert.equal(unsupported.some(e => e.deepSeek), false);

  const disabled = await collect({ imagePaths: [imagePath] }, { deepSeekFallback: false });
  assert.equal(disabled.some(e => e.deepSeek), false);
  assert.equal(disabled.some(e => e.type === "error"), true);

  const stopped = await collect({}, {}, (event, owner) => {
    if (event.type === "thread_started") killCodexProcess(owner);
  });
  assert.equal(stopped.some(e => e.deepSeek), false);
  assert.equal(stopped.some(e => e.type === "cancelled"), true);

  const harnessStopped = await collect({}, {}, (event, owner) => {
    if (event.type === "status" && event.content.includes("Trying DeepSeek")) killCodexProcess(owner);
  });
  assert.equal(harnessStopped.some(e => e.deepSeek), false);
  assert.equal(harnessStopped.some(e => e.type === "cancelled"), true);

  const imageStopped = await collect({ imagePaths: [imagePath] }, {}, (event, owner) => {
    if (event.type === "status" && event.content.includes("Trying DeepSeek")) killCodexProcess(owner);
  });
  assert.equal(imageStopped.some(e => e.deepSeek), false);
  assert.equal(imageStopped.some(e => e.type === "cancelled"), true);

  const unavailable = await collect({}, { deepSeekHarnessPath: path.join(temporary, "missing-dsh") });
  assert(unavailable.some(e => e.type === "error" && e.content.includes("workspace routing")));
  assert(unavailable.some(e => e.type === "error" && e.content.includes("DeepSeek Harness")));

  const usageLimitMessage = "You've hit your usage limit. Try again later.";
  const quotaFailures = [
    failure(usageLimitMessage),
    failure("You’ve hit your usage limit for this model. Switch to another model now."),
    failure("Usage limit reached"),
    failure("Quota exceeded. Check your plan and billing details."),
    failure("Your workspace is out of credits."),
    emit({ type: "turn.failed", error: { message: "Request rejected", code: "usage_limit_reached" } }),
    emit({ type: "turn.failed", error: { message: "Request rejected", code: "quota_exceeded" } }),
    emit({ type: "error", message: "Request rejected", code: "rate_limit_exceeded" }),
  ];
  for (const quotaFailure of quotaFailures) {
    writeExecutable(codex, [thread, quotaFailure, "process.exitCode = 1;"].join("\n"));
    const events = await collect({ fallbackPrompt: () => handoff });
    assert.equal(events.filter(e => e.deepSeek).length, 1);
    assert.equal(events.find(e => e.type === "text")?.content, handoff);
    assert(events.some(e => e.type === "status" && e.content.includes("usage limit reached")));
    assert.equal(events.some(e => e.type === "error"), false);
  }
  const quotaImage = await collect({ imagePaths: [imagePath] });
  assert.equal(quotaImage.find(e => e.deepSeek)?.threadId, "session-image");
  const quotaDisabled = await collect({}, { deepSeekFallback: false });
  assert.equal(quotaDisabled.some(e => e.deepSeek), false);
  assert(quotaDisabled.some(e => e.type === "error"));
  const quotaCancelled = await collect({}, {}, (event, owner) => {
    if (event.type === "thread_started") killCodexProcess(owner);
  });
  assert.equal(quotaCancelled.some(e => e.deepSeek), false);
  assert(quotaCancelled.some(e => e.type === "cancelled"));
  for (const activity of [tool, success[0]]) {
    writeExecutable(codex, [thread, activity, failure(usageLimitMessage), "process.exitCode = 1;"].join("\n"));
    const events = await collect();
    assert.equal(events.some(e => e.deepSeek), false);
    assert(events.some(e => e.type === "error"));
  }
  for (const unrelated of ["401 Unauthorized", "context_window_exceeded", "agent_limit_reached", "session_budget_exceeded", "429 from a tool endpoint"]) {
    assert.equal(isCodexUsageLimitFailure(unrelated), false);
    writeExecutable(codex, [thread, failure(unrelated), "process.exitCode = 1;"].join("\n"));
    assert.equal((await collect()).some(e => e.deepSeek), false);
  }
  console.log("PASS: usage caps and quota codes trigger text/image fallback, with cancellation, disabled setting, prior activity, and unrelated errors guarded");

  writeExecutable(codex, [thread, retry, tool, failure(offline), "process.exitCode = 1;"].join("\n"));
  assert.equal((await collect()).some(e => e.deepSeek), false);
  writeExecutable(codex, [thread, failure("401 Unauthorized"), "process.exitCode = 1;"].join("\n"));
  assert.equal((await collect()).some(e => e.deepSeek), false);
  writeExecutable(codex, [thread, retry, ...success].join("\n"));
  const recovered = await collect();
  assert.equal(recovered.some(e => e.deepSeek || e.type === "error"), false);
  assert.equal(recovered.find(e => e.type === "text").content, "Codex reply");
  console.log("PASS: fallback, resume, image routing and format validation, disabled setting, cancellation, unavailable Harness, tool guard, authentication failure, and Codex recovery");

  if (process.argv.includes("--live-quota")) {
    writeExecutable(codex, [thread, failure(usageLimitMessage), "process.exitCode = 1;"].join("\n"));
    const events = await collect(
      { prompt: "Reply with exactly QUOTA_FALLBACK_OK. Do not use tools." },
      { deepSeekHarnessPath: DEEPSEEK_HARNESS_PATH },
    );
    assert(events.some(e => e.deepSeek));
    assert(events.some(e => e.type === "status" && e.content.includes("usage limit reached")));
    assert.equal(events.find(e => e.type === "text")?.content.trim(), "QUOTA_FALLBACK_OK");
    console.log("PASS: simulated Codex subscription limit falls back to the installed DeepSeek Harness");
  }

  if (process.argv.includes("--live")) {
    writeExecutable(codex, [thread, retry, diagnostic, failure(offline), "process.exitCode = 1;"].join("\n"));
    const overrides = { deepSeekHarnessPath: DEEPSEEK_HARNESS_PATH };
    const initial = await collect({ prompt: "请只回复 RENDERER_FALLBACK_OK，不要使用工具。" }, overrides);
    assert.match(initial.find(e => e.type === "text")?.content ?? JSON.stringify(initial), /^RENDERER_FALLBACK_OK$/);
    const sessionId = initial.find(e => e.deepSeek).threadId;
    const resumed = await collect({ deepSeekSession: true, sessionId, prompt: "请重复你刚才回复的那串字符，只回复字符本身。" }, overrides);
    assert.match(resumed.find(e => e.type === "text")?.content ?? JSON.stringify(resumed), /^RENDERER_FALLBACK_OK$/);
    assert.equal(resumed.find(e => e.deepSeek).threadId, sessionId);
    const visionPrompt = "Name the dominant colors on the left and right of this image, in that order. Answer with only the two color names in English. Do not use tools.";
    const freshImage = await collect({ imagePaths: [imagePath], prompt: visionPrompt }, overrides);
    assert.match(freshImage.find(e => e.type === "text")?.content ?? JSON.stringify(freshImage), /green[\s\S]*blue/i);
    assert(freshImage.some(e => e.deepSeek));
    const continuedImage = await collect({ deepSeekSession: true, sessionId, imagePaths: [imagePath], prompt: visionPrompt }, overrides);
    assert.match(continuedImage.find(e => e.type === "text")?.content ?? JSON.stringify(continuedImage), /green[\s\S]*blue/i);
    assert.equal(continuedImage.find(e => e.deepSeek)?.threadId, sessionId);
    const continuedText = await collect({ deepSeekSession: true, sessionId, prompt: "Repeat the color on the right from your previous answer. Answer with just the color name in English." }, overrides);
    assert.match(continuedText.find(e => e.type === "text")?.content ?? JSON.stringify(continuedText), /blue/i);
    assert.equal(continuedText.find(e => e.deepSeek)?.threadId, sessionId);
    console.log("PASS: live image fallback, adding an image to an existing text session, and text follow-up");
    console.log("PASS: live DeepSeek Harness fallback and context-preserving resume");
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
