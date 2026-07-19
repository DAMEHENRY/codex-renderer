// Tests for Codex Renderer pure session logic.
// Run: npm test (builds session-logic.ts -> session-logic-bundle.cjs, then runs this)

const {
  buildReasoningEffortArg,
  buildModelArg,
  buildSearchArg,
  buildSandboxArg,
  buildApprovalArg,
  buildImageArgs,
  buildCodexExecArgs,
  buildCodexChildPath,
  CODEX_CHILD_PATH_PREPEND,
  CODEX_CLI_ABSOLUTE_FALLBACKS,
  resolveExecutablePath,
  parseCodexJsonlLine,
  looksLikeInvalidResume,
  classifyFinalStatus,
  buildContextPrompt,
  truncateText,
  getSupportedFiles,
  fileTypeBadge,
  generateTitle,
  cloneMessage,
  extractMentionedPaths,
  formatContextSummary,
  isImageFilePath,
  appendPartialWarning,
  parseModelsJson,
  getFallbackModelCatalog,
  getEffortOptionsForModel,
  getEffortDisplayLabel,
  CODEX_APP_ENABLED_REASONING_EFFORTS,
  getImageOnlyPromptAndDisplay,
  imageSrcForPath,
  normalizeMathForObsidian,
} = require("./session-logic-bundle.cjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

function assertDeepEqual(a, b, label) {
  const strA = JSON.stringify(a);
  const strB = JSON.stringify(b);
  if (strA === strB) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  Expected: ${strB}\n  Got:      ${strA}`);
  }
}

// ─── buildReasoningEffortArg ─────────────────────────────────────────────
assertDeepEqual(buildReasoningEffortArg("default"), [], "reasoning effort default");
assertDeepEqual(buildReasoningEffortArg(""), [], "reasoning effort empty");
assertDeepEqual(buildReasoningEffortArg("invalid"), [], "reasoning effort invalid");
assertDeepEqual(buildReasoningEffortArg("low"), ["-c", 'model_reasoning_effort="low"'], "reasoning effort low");
assertDeepEqual(buildReasoningEffortArg("high"), ["-c", 'model_reasoning_effort="high"'], "reasoning effort high");
assertDeepEqual(buildReasoningEffortArg("max"), ["-c", 'model_reasoning_effort="max"'], "reasoning effort max");
assertDeepEqual(buildReasoningEffortArg("ultra"), ["-c", 'model_reasoning_effort="ultra"'], "reasoning effort ultra");

// ─── buildModelArg ───────────────────────────────────────────────────────
assertDeepEqual(buildModelArg("default"), [], "model default");
assertDeepEqual(buildModelArg(""), [], "model empty");
assertDeepEqual(buildModelArg("gpt-4o"), ["-m", "gpt-4o"], "model gpt-4o");

// ─── buildSearchArg ──────────────────────────────────────────────────────
assertDeepEqual(buildSearchArg("off"), [], "search off");
assertDeepEqual(buildSearchArg("search"), ["--search"], "search on");
assertDeepEqual(buildSearchArg(""), [], "search empty");

// ─── buildSandboxArg ─────────────────────────────────────────────────────
assertDeepEqual(buildSandboxArg("default"), ["--sandbox", "workspace-write"], "sandbox default");
assertDeepEqual(buildSandboxArg(""), ["--sandbox", "workspace-write"], "sandbox empty");
assertDeepEqual(buildSandboxArg("read-only"), ["--sandbox", "read-only"], "sandbox read-only");

// ─── buildApprovalArg ────────────────────────────────────────────────────
assertDeepEqual(buildApprovalArg("default"), [], "approval default is no-op for codex exec");
assertDeepEqual(buildApprovalArg(""), [], "approval empty is no-op for codex exec");
assertDeepEqual(buildApprovalArg("always"), [], "approval unsupported by codex exec");

// ─── buildImageArgs ──────────────────────────────────────────────────────
assertDeepEqual(buildImageArgs([]), [], "empty image args");
assertDeepEqual(buildImageArgs(["/path/to/img1.png"]), ["-i", "/path/to/img1.png"], "one image arg");
assertDeepEqual(buildImageArgs(["/path/to/img1.png", "/path/to/img2.jpg"]), ["-i", "/path/to/img1.png", "-i", "/path/to/img2.jpg"], "multiple image args");

// ─── buildCodexExecArgs ──────────────────────────────────────────────────
{
  const opts = {
    vaultRoot: "/Users/henry/Vault",
    model: "gpt-4o",
    reasoningEffort: "medium",
    webSearchMode: "search",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    imagePaths: ["/Users/henry/image.png"],
  };
  const expectedArgs = [
    "--search",
    "exec", "--json", "-C", "/Users/henry/Vault",
    "-m", "gpt-4o",
    "-c", 'model_reasoning_effort="medium"',
    "--sandbox", "workspace-write",
    "-i", "/Users/henry/image.png",
    "--",
    "-",
  ];
  assertDeepEqual(buildCodexExecArgs(opts), expectedArgs, "buildCodexExecArgs new chat full options");
}

{
  const opts = {
    vaultRoot: "/Users/henry/Vault",
    sessionId: "d2dbe5be-ee46-4c4f-a9db-9cb00e57f093",
  };
  const expectedArgs = [
    "exec", "resume", "--json", "d2dbe5be-ee46-4c4f-a9db-9cb00e57f093",
    "--",
    "-",
  ];
  assertDeepEqual(buildCodexExecArgs(opts), expectedArgs, "buildCodexExecArgs resume chat defaults");
}

{
  const opts = {
    vaultRoot: "/Users/henry/Vault",
    sessionId: "d2dbe5be-ee46-4c4f-a9db-9cb00e57f093",
    webSearchMode: "search",
    sandboxMode: "workspace-write",
    approvalPolicy: "always",
    model: "gpt-4o",
    reasoningEffort: "medium",
  };
  const expectedArgs = [
    "exec", "resume", "--json", "d2dbe5be-ee46-4c4f-a9db-9cb00e57f093",
    "-m", "gpt-4o",
    "-c", 'model_reasoning_effort="medium"',
    "--",
    "-",
  ];
  assertDeepEqual(buildCodexExecArgs(opts), expectedArgs, "buildCodexExecArgs resume ignores search, sandbox, vaultRoot, approval");
}

// ─── buildCodexChildPath ─────────────────────────────────────────────────
{
  const childPath = buildCodexChildPath("/usr/bin:/bin:/usr/sbin:/sbin");
  const parts = childPath.split(":");
  assertDeepEqual(parts.slice(0, CODEX_CHILD_PATH_PREPEND.length), CODEX_CHILD_PATH_PREPEND, "child PATH prepends Codex and Homebrew paths");
  assert(parts.includes("/usr/bin"), "child PATH keeps original system path");
}

{
  const childPath = buildCodexChildPath("/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/bin");
  const parts = childPath.split(":");
  assert(parts.filter((p) => p === "/opt/homebrew/bin").length === 1, "child PATH removes duplicate Homebrew bin");
  assert(parts.filter((p) => p === "/usr/bin").length === 1, "child PATH removes duplicate original entries");
}

{
  const childPath = buildCodexChildPath("");
  assertDeepEqual(childPath.split(":"), CODEX_CHILD_PATH_PREPEND, "child PATH works when base PATH is empty");
}

{
  const executable = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const resolved = resolveExecutablePath("codex", "/usr/bin:/bin", (candidate) => candidate === executable);
  assert(resolved.path === executable, "resolve executable uses ChatGPT app fallback");
  assert(resolved.candidates.includes("/usr/bin/codex"), "resolve executable searches GUI PATH");
}

{
  const executable = "/custom/codex";
  const resolved = resolveExecutablePath(executable, "/usr/bin", (candidate) => candidate === executable);
  assert(resolved.path === executable, "resolve executable honors configured absolute path");
}

{
  const resolved = resolveExecutablePath("codex", "/usr/bin:/bin", () => false);
  assert(resolved.path === null, "resolve executable reports missing CLI");
  assertDeepEqual(resolved.candidates.slice(-CODEX_CLI_ABSOLUTE_FALLBACKS.length), CODEX_CLI_ABSOLUTE_FALLBACKS, "resolve executable reports all app fallbacks");
}

// ─── parseCodexJsonlLine ─────────────────────────────────────────────────
assert(parseCodexJsonlLine("") === null, "parse empty line");
assert(parseCodexJsonlLine("   ") === null, "parse whitespace line");
assert(parseCodexJsonlLine("invalid json") === null, "parse invalid json");

{
  const threadLine = '{"type":"thread.started","thread_id":"sess-123"}';
  const parsed = parseCodexJsonlLine(threadLine);
  assert(parsed && parsed.type === "thread.started", "parse thread.started type");
  assert(parsed && parsed.threadId === "sess-123", "parse thread.started threadId");
}

{
  const itemLine = '{"type":"item.completed","item":{"type":"agent_message","text":"Hello world","id":"item-1"}}';
  const parsed = parseCodexJsonlLine(itemLine);
  assert(parsed && parsed.type === "item.completed", "parse item.completed type");
  assert(parsed && parsed.itemType === "agent_message", "parse item.completed itemType");
  assert(parsed && parsed.text === "Hello world", "parse item.completed text");
  assert(parsed && parsed.itemId === "item-1", "parse item.completed itemId");
}

{
  const turnLine = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}';
  const parsed = parseCodexJsonlLine(turnLine);
  assert(parsed && parsed.type === "turn.completed", "parse turn.completed type");
  assert(parsed && parsed.usage.input_tokens === 10, "parse turn.completed input_tokens");
  assert(parsed && parsed.usage.output_tokens === 20, "parse turn.completed output_tokens");
}

{
  const errorLine = '{"type":"error","message":"CLI failure"}';
  const parsed = parseCodexJsonlLine(errorLine);
  assert(parsed && parsed.type === "error", "parse error type");
  assert(parsed && parsed.message === "CLI failure", "parse error message");
}

{
  const turnFailedLine = '{"type":"turn.failed","error":{"message":"API error"}}';
  const parsed = parseCodexJsonlLine(turnFailedLine);
  assert(parsed && parsed.type === "turn.failed", "parse turn.failed type");
  assert(parsed && parsed.message === "API error", "parse turn.failed message");
}

// ─── looksLikeInvalidResume ──────────────────────────────────────────────
assert(looksLikeInvalidResume(null) === true, "looksLikeInvalidResume null");
assert(looksLikeInvalidResume(undefined) === true, "looksLikeInvalidResume undefined");
assert(looksLikeInvalidResume("") === true, "looksLikeInvalidResume empty");
assert(looksLikeInvalidResume("invalid-uuid") === true, "looksLikeInvalidResume non-uuid");
assert(looksLikeInvalidResume("d2dbe5be-ee46-4c4f-a9db-9cb00e57f093") === false, "looksLikeInvalidResume valid UUID");
assert(looksLikeInvalidResume("D2DBE5BE-EE46-4C4F-A9DB-9CB00E57F093") === false, "looksLikeInvalidResume valid uppercase UUID");

// ─── classifyFinalStatus ─────────────────────────────────────────────────
{
  const opts = { exitCode: 0, signal: null, hasThreadStarted: true, hasTurnCompleted: true, hasError: false, timedOut: false, spawnFailed: false };
  assert(classifyFinalStatus(opts) === "success", "classify success");
}
{
  const opts = { exitCode: 1, signal: null, hasThreadStarted: true, hasTurnCompleted: true, hasError: false, timedOut: false, spawnFailed: false };
  assert(classifyFinalStatus(opts) === "process-error", "classify process-error");
}
{
  const opts = { exitCode: null, signal: "SIGTERM", hasThreadStarted: true, hasTurnCompleted: true, hasError: false, timedOut: false, spawnFailed: false };
  assert(classifyFinalStatus(opts) === "cancelled", "classify SIGTERM as cancelled");
}
{
  const opts = { exitCode: null, signal: null, hasThreadStarted: true, hasTurnCompleted: true, hasError: false, timedOut: true, spawnFailed: false };
  assert(classifyFinalStatus(opts) === "timeout", "classify timeout");
}
{
  const opts = { exitCode: null, signal: null, hasThreadStarted: false, hasTurnCompleted: false, hasError: false, timedOut: false, spawnFailed: true };
  assert(classifyFinalStatus(opts) === "spawn-error", "classify spawn-error");
}
{
  const opts = { exitCode: 0, signal: null, hasThreadStarted: true, hasTurnCompleted: true, hasError: true, errorMessage: "fail", timedOut: false, spawnFailed: false };
  assert(classifyFinalStatus(opts) === "error", "classify error flag");
}
{
  const opts = { exitCode: 0, signal: null, hasThreadStarted: false, hasTurnCompleted: false, hasError: false, timedOut: false, spawnFailed: false };
  assert(classifyFinalStatus(opts) === "no-result", "classify no thread started");
}
{
  const opts = { exitCode: 0, signal: null, hasThreadStarted: true, hasTurnCompleted: false, hasError: false, timedOut: false, spawnFailed: false };
  assert(classifyFinalStatus(opts) === "process-error", "classify turn not completed");
}

// ─── Context Prompt building and Truncation ──────────────────────────────
{
  const chips = [
    { type: "selection", label: "Selection 1", data: "Selection content", sourcePath: "a.md", lines: "5-10" },
    { type: "pdf-selection", label: "PDF Selection", data: "PDF text content", sourcePath: "b.pdf", lines: "unknown" },
    { type: "message-quote", label: "Quote", data: "Earlier <answer> & context", sourcePath: "chat://current-session/assistant/123" },
    { type: "file", label: "File 1", data: "File content & special <tags>", sourcePath: "c.md" },
    { type: "image", label: "Image 1", data: "", sourcePath: "d.png", mime: "image/png" }
  ];
  const prompt = buildContextPrompt(chips, 1000, 10000);
  assert(prompt.includes('<selected_text path="a.md" lines="5-10">'), "has selected_text open tag");
  assert(prompt.includes("Selection content"), "has selection text");
  assert(prompt.includes('<pdf_selection path="b.pdf" page="unknown">'), "has pdf_selection open tag");
  assert(prompt.includes("PDF text content"), "has pdf selection text");
  assert(prompt.includes('<quoted_message role="assistant">'), "has quoted_message open tag");
  assert(prompt.includes("Earlier &lt;answer&gt; &amp; context"), "escapes quote content");
  assert(prompt.includes('<file_context path="c.md">'), "has file_context open tag");
  assert(prompt.includes("File content &amp; special &lt;tags&gt;"), "escapes XML content");
  assert(prompt.includes('<image path="d.png" mime="image/png" />'), "has image tag");
}

assert(truncateText("hello world", 5) === "hello\n... [truncated]", "truncate text");
assert(truncateText("hello", 10) === "hello", "no truncate needed");

// ─── getSupportedFiles ───────────────────────────────────────────────────
{
  const files = [
    { path: "foo.md", name: "foo.md", extension: "md" },
    { path: "notes/foo.md", name: "foo.md", extension: "md" },
    { path: "bar.pdf", name: "bar.pdf", extension: "pdf" },
    { path: "baz.png", name: "baz.png", extension: "png" },
    { path: "large.zip", name: "large.zip", extension: "zip" } // unsupported extension
  ];

  const results = getSupportedFiles(files, "foo");
  assert(results.length === 2, "filters out unsupported extension and non-matching name");
  assert(results[0].path === "foo.md", "exact basename matches first");
  assert(results[1].path === "notes/foo.md", "partial matches next");

  const resultsAll = getSupportedFiles(files, "");
  assert(resultsAll.length === 4, "empty query matches all supported files");
}

// ─── fileTypeBadge ───────────────────────────────────────────────────────
assert(fileTypeBadge("png") === "IMG", "png badge");
assert(fileTypeBadge("JPG") === "IMG", "uppercase badge");
assert(fileTypeBadge("pdf") === "PDF", "pdf badge");
assert(fileTypeBadge("md") === "MD", "md badge");
assert(fileTypeBadge("ts") === "TS", "other badge");

// ─── generateTitle ───────────────────────────────────────────────────────
assert(generateTitle("First line\nSecond line") === "First line", "generate title from first line");
assert(generateTitle("<context>ignored</context>\nReal Title") === "Real Title", "generate title ignores context block");

// ─── cloneMessage ────────────────────────────────────────────────────────
{
  const original = { text: "hello", list: [1, 2] };
  const cloned = cloneMessage(original);
  assert(cloned.text === "hello", "clone text");
  assert(cloned !== original, "clone is new object");
  assert(cloned.list !== original.list, "clone nested is new array");
}

// ─── extractMentionedPaths ────────────────────────────────────────────────
{
  const text = "Check out @docs/setup.md and also @image.png, but not user@domain.com";
  const paths = extractMentionedPaths(text);
  assertDeepEqual(paths, ["docs/setup.md", "image.png"], "extract mentioned paths");
}

// ─── formatContextSummary ─────────────────────────────────────────────────
{
  const chips = [
    { type: "selection", label: "S", data: "", sourcePath: "a.md" },
    { type: "pdf-selection", label: "P", data: "", sourcePath: "b.pdf" },
    { type: "message-quote", label: "Q", data: "", sourcePath: "chat://current-session/user/123" },
    { type: "file", label: "F", data: "", sourcePath: "c.md" },
    { type: "image", label: "I", data: "", sourcePath: "d.png" }
  ];
  assert(formatContextSummary(chips) === "selection from a.md, PDF selection from b.pdf, quote from user, c.md, image: d.png", "formatContextSummary description");
}

// ─── isImageFilePath ──────────────────────────────────────────────────────
assert(isImageFilePath("a.png") === true, "png extension image");
assert(isImageFilePath("a.md") === false, "md extension non-image");

// ─── appendPartialWarning ─────────────────────────────────────────────────
assert(appendPartialWarning("Hello").includes("incomplete"), "appends warning correctly");

// ─── parseModelsJson ──────────────────────────────────────────────────────
{
  const json = JSON.stringify({
    models: [
      { slug: "model-1", display_name: "Model 1", visibility: "list", default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }] },
      { slug: "model-2", display_name: "Model 2", visibility: "hidden", supported_reasoning_levels: ["low"] }
    ]
  });
  const parsed = parseModelsJson(json);
  assert(parsed.length === 1, "parseModelsJson filters out non-list models");
  assert(parsed[0].slug === "model-1", "parseModelsJson parses slug");
  assertDeepEqual(parsed[0].supportedReasoningLevels, ["low", "max", "ultra"], "parseModelsJson maps supported reasoning levels");
  assert(parsed[0].defaultReasoningLevel === "high", "parseModelsJson maps default reasoning level");
}

// ─── getFallbackModelCatalog ──────────────────────────────────────────────
{
  const catalog = getFallbackModelCatalog();
  assert(catalog.length === 6, "fallback catalog has current offline entries");
  assert(catalog.some(m => m.slug === "gpt-5.6-sol"), "fallback has gpt-5.6-sol");
  assert(catalog.some(m => m.slug === "gpt-5.5"), "fallback has gpt-5.5");
  assert(catalog.some(m => m.slug === "gpt-5.4"), "fallback has gpt-5.4");
  assert(catalog.some(m => m.slug === "gpt-5.4-mini"), "fallback has gpt-5.4-mini");
}

// ─── getEffortOptionsForModel ─────────────────────────────────────────────
{
  const catalog = [
    { slug: "model-1", displayName: "M1", supportedReasoningLevels: ["none", "low", "medium", "xhigh", "max", "ultra"] }
  ];
  assertDeepEqual(getEffortOptionsForModel("", catalog), ["default"], "default model does not guess effort options");
  assertDeepEqual(getEffortOptionsForModel("model-1", catalog), ["low", "medium", "xhigh", "ultra"], "model efforts match Codex app enabled levels");
  assertDeepEqual(getEffortOptionsForModel("unknown", catalog), ["default"], "unknown model does not guess effort options");
  assertDeepEqual(CODEX_APP_ENABLED_REASONING_EFFORTS, ["low", "medium", "high", "xhigh", "ultra"], "Codex app effort order");
  assert(getEffortDisplayLabel("low") === "Light", "low displays as Light");
  assert(getEffortDisplayLabel("xhigh") === "Extra High", "xhigh displays as Extra High");
  assert(getEffortDisplayLabel("ultra") === "Ultra", "ultra displays as Ultra");
}

// ─── getImageOnlyPromptAndDisplay ──────────────────────────────────────────
{
  const res1 = getImageOnlyPromptAndDisplay(true, "");
  assert(res1.isImageOnly === true, "image-only flag is true");
  assert(res1.prompt === "Please inspect the attached image.", "image-only prompt");
  assert(res1.displayContent === "[image attachment]", "image-only displayContent");

  const res2 = getImageOnlyPromptAndDisplay(true, "Hello world");
  assert(res2.isImageOnly === false, "text message with images is not image-only");
  assert(res2.prompt === "Hello world", "uses user text as prompt");
  assert(res2.displayContent === "Hello world", "uses user text as displayContent");
}

// ─── imageSrcForPath ──────────────────────────────────────────────────────
{
  const urlStr = imageSrcForPath("/abs/path/img.png");
  assert(urlStr.startsWith("file://"), "converts path to file:// URL");
  assert(urlStr.includes("img.png"), "url includes filename");
}

// ─── normalizeMathForObsidian ─────────────────────────────────────────────
{
  const source = "Before\n\\[\nP_t=\\frac{1}{K}\\sum_{j=0}^{K-1} C_{t-j}\n\\]\nAfter";
  const result = normalizeMathForObsidian(source);
  assert(result.markdown.includes("$$\nP_t=\\frac{1}{K}\\sum_{j=0}^{K-1} C_{t-j}\n$$"), "normalizes bracketed block math");
  assertDeepEqual(result.mathSources, ["$$\nP_t=\\frac{1}{K}\\sum_{j=0}^{K-1} C_{t-j}\n$$"], "captures normalized block source");
}

{
  const source = "Use \\(K=5\\), keep $x_t$, and show $$y_t=2$$.";
  const result = normalizeMathForObsidian(source);
  assert(result.markdown === "Use $K=5$, keep $x_t$, and show $$y_t=2$$.", "normalizes inline math and preserves dollar math");
  assertDeepEqual(result.mathSources, ["$K=5$", "$x_t$", "$$y_t=2$$"], "captures math sources in document order");
}

{
  const source = [
    "```md",
    "\\[not math\\] and $also_not_math$",
    "```",
    "Inline `\\(not math\\)` stays code.",
    "~~~",
    "$$not math$$",
    "~~~",
  ].join("\n");
  const result = normalizeMathForObsidian(source);
  assert(result.markdown === source, "leaves fenced and inline code unchanged");
  assertDeepEqual(result.mathSources, [], "does not capture math inside code");
}

{
  const source = "Unmatched \\(K and \\[x stay unchanged; escaped \\$5 is money.";
  const result = normalizeMathForObsidian(source);
  assert(result.markdown === source, "leaves unmatched and escaped delimiters unchanged");
  assertDeepEqual(result.mathSources, [], "does not capture unmatched delimiters");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
