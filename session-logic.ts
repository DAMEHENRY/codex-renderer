/**
 * session-logic.ts — Pure logic for Codex Renderer.
 *
 * No DOM, no Obsidian imports, no side effects. Every function here is
 * deterministic and unit-testable from a CJS test bundle.
 */

import { fileURLToPath, pathToFileURL } from "url";
import { homedir } from "os";
import { isAbsolute, relative, resolve, sep } from "path";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

export const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico",
]);

export const SUPPORTED_EXTENSIONS = new Set([
  "md", "pdf", "html", "htm", "txt", "json", "yaml", "yml",
  "ts", "tsx", "js", "jsx", "css", "scss", "less",
  "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp",
  "sh", "bash", "zsh", "fish",
  "csv", "tsv", "xml", "toml",
  ...IMAGE_EXTENSIONS,
]);

export const EXTENSION_RANK: Record<string, number> = {
  md: 0, pdf: 1, html: 2, htm: 3, txt: 4, json: 5,
  ts: 6, js: 7, py: 8, yaml: 9, yml: 10, toml: 11,
};

export const CODEX_CHILD_PATH_PREPEND = [
  "/Applications/ChatGPT.app/Contents/Resources",
  "/Applications/Codex.app/Contents/Resources",
  `${homedir()}/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/homebrew/sbin",
  "/usr/local/sbin",
];

export const CODEX_CLI_ABSOLUTE_FALLBACKS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

export function buildCodexChildPath(basePath: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const entry of [...CODEX_CHILD_PATH_PREPEND, ...(basePath || "").split(":")]) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push(trimmed);
  }

  return parts.join(":");
}

export function resolveExecutablePath(
  configuredPath: string,
  searchPath: string,
  isExecutable: (candidate: string) => boolean,
): { path: string | null; candidates: string[] } {
  const configured = (configuredPath || "codex").trim();
  const candidates: string[] = [];
  const add = (candidate: string) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  if (configured.includes("/")) {
    add(configured);
  } else {
    for (const dir of (searchPath || "").split(":")) {
      const trimmed = dir.trim().replace(/\/$/, "");
      if (trimmed) add(`${trimmed}/${configured}`);
    }
  }
  for (const fallback of CODEX_CLI_ABSOLUTE_FALLBACKS) add(fallback);

  return {
    path: candidates.find(isExecutable) || null,
    candidates,
  };
}

/* ------------------------------------------------------------------ */
/*  Codex CLI argument builders                                       */
/* ------------------------------------------------------------------ */

/**
 * Build `-c model_reasoning_effort="<value>"` args.
 * Returns empty array for "default" (don't override).
 */
export function buildReasoningEffortArg(effort: string): string[] {
  if (!effort || effort === "default") return [];
  const valid = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (!valid.includes(effort)) return [];
  return ["-c", `model_reasoning_effort="${effort}"`];
}

/**
 * Build `-m <model>` args.
 * Returns empty array for "default" or empty string.
 */
export function buildModelArg(model: string): string[] {
  if (!model || model === "default") return [];
  return ["-m", model];
}

/**
 * Build `--search` arg if web search is enabled.
 */
export function buildSearchArg(mode: string): string[] {
  return mode === "search" ? ["--search"] : [];
}

/**
 * Build `--sandbox <mode>` arg.
 */
export function buildSandboxArg(mode: string): string[] {
  if (!mode || mode === "default") return ["--sandbox", "workspace-write"];
  return ["--sandbox", mode];
}

/**
 * Codex's top-level CLI supports approval policy flags, but `codex exec`
 * does not. Keep this helper as an explicit no-op so older settings do not
 * leak unsupported args into the non-interactive renderer path.
 */
export function buildApprovalArg(_policy: string): string[] {
  return [];
}

/**
 * Build `-i <file>` args for image attachments.
 */
export function buildImageArgs(imagePaths: string[]): string[] {
  const args: string[] = [];
  for (const p of imagePaths) {
    if (p) args.push("-i", p);
  }
  return args;
}

/**
 * Assemble the full argument list for `codex exec`.
 */
export function buildCodexExecArgs(opts: {
  vaultRoot: string;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  webSearchMode?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  imagePaths?: string[];
}): string[] {
  const args: string[] = [];

  // Top-level options must go BEFORE the subcommand name ("exec")
  if (!opts.sessionId && opts.webSearchMode === "search") {
    args.push("--search");
  }

  if (opts.sessionId) {
    // Resume: codex exec resume --json <sessionId> -
    args.push("exec", "resume", "--json", opts.sessionId);
    args.push(...buildModelArg(opts.model || ""));
    args.push(...buildReasoningEffortArg(opts.reasoningEffort || "default"));
    args.push(...buildImageArgs(opts.imagePaths || []));
  } else {
    // New chat: codex exec --json -C <vaultRoot> -
    args.push("exec", "--json", "-C", opts.vaultRoot);
    args.push(...buildModelArg(opts.model || ""));
    args.push(...buildReasoningEffortArg(opts.reasoningEffort || "default"));
    args.push(...buildSandboxArg(opts.sandboxMode || "default"));
    args.push(...buildApprovalArg(opts.approvalPolicy || "default"));
    args.push(...buildImageArgs(opts.imagePaths || []));
  }

  // `--` followed by `-` terminates options, ensuring `-` is parsed as the prompt (stdin)
  // and not consumed by variadic option like `-i` / `--image`.
  args.push("--", "-");

  return args;
}

/* ------------------------------------------------------------------ */
/*  Markdown math normalization                                      */
/* ------------------------------------------------------------------ */

export interface NormalizedMathMarkdown {
  markdown: string;
  mathSources: string[];
}

/**
 * Convert common LaTeX delimiters into the dollar-delimited form that
 * Obsidian's MarkdownRenderer understands. Code spans/fences and unmatched
 * delimiters are preserved verbatim. Sources remain in rendered document
 * order so the UI can associate MathJax nodes with their original LaTeX.
 */
export function normalizeMathForObsidian(markdown: string): NormalizedMathMarkdown {
  const mathSources: string[] = [];
  let output = "";
  let index = 0;
  let atLineStart = true;
  let fence: { char: "`" | "~"; length: number } | null = null;

  while (index < markdown.length) {
    if (atLineStart) {
      const lineEnd = markdown.indexOf("\n", index);
      const contentEnd = lineEnd === -1 ? markdown.length : lineEnd;
      const line = markdown.slice(index, contentEnd);
      const fenceRun = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);

      if (fence) {
        output += markdown.slice(index, lineEnd === -1 ? markdown.length : lineEnd + 1);
        const closingRun = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/);
        if (closingRun && closingRun[1][0] === fence.char && closingRun[1].length >= fence.length) {
          fence = null;
        }
        if (lineEnd === -1) break;
        index = lineEnd + 1;
        atLineStart = true;
        continue;
      }

      if (fenceRun) {
        fence = {
          char: fenceRun[1][0] as "`" | "~",
          length: fenceRun[1].length,
        };
        output += markdown.slice(index, lineEnd === -1 ? markdown.length : lineEnd + 1);
        if (lineEnd === -1) break;
        index = lineEnd + 1;
        atLineStart = true;
        continue;
      }
    }

    if (markdown[index] === "`") {
      const runLength = countRun(markdown, index, "`");
      const delimiter = "`".repeat(runLength);
      const closingIndex = markdown.indexOf(delimiter, index + runLength);
      if (closingIndex !== -1) {
        const end = closingIndex + runLength;
        const raw = markdown.slice(index, end);
        output += raw;
        index = end;
        atLineStart = raw.endsWith("\n");
        continue;
      }
    }

    const delimiter = mathDelimiterAt(markdown, index);
    if (delimiter) {
      const closingIndex = findClosingMathDelimiter(
        markdown,
        index + delimiter.open.length,
        delimiter.close,
        delimiter.allowNewlines,
      );

      if (closingIndex !== -1) {
        const body = markdown.slice(index + delimiter.open.length, closingIndex);
        const inlineDollarIsValid = delimiter.open !== "$" || (
          body.length > 0 && !/^\s/.test(body) && !/\s$/.test(body)
        );

        if (inlineDollarIsValid) {
          const canonical = delimiter.block ? `$$${body}$$` : `$${body}$`;
          output += canonical;
          mathSources.push(canonical);
          index = closingIndex + delimiter.close.length;
          atLineStart = canonical.endsWith("\n");
          continue;
        }
      }
    }

    const char = markdown[index];
    output += char;
    index += 1;
    atLineStart = char === "\n";
  }

  return { markdown: output, mathSources };
}

function countRun(text: string, start: number, char: string): number {
  let length = 0;
  while (text[start + length] === char) length += 1;
  return length;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function mathDelimiterAt(
  text: string,
  index: number,
): { open: string; close: string; block: boolean; allowNewlines: boolean } | null {
  if (text.startsWith("\\[", index) && !isEscaped(text, index)) {
    return { open: "\\[", close: "\\]", block: true, allowNewlines: true };
  }
  if (text.startsWith("\\(", index) && !isEscaped(text, index)) {
    return { open: "\\(", close: "\\)", block: false, allowNewlines: false };
  }
  if (text.startsWith("$$", index) && !isEscaped(text, index)) {
    return { open: "$$", close: "$$", block: true, allowNewlines: true };
  }
  if (text[index] === "$" && text[index + 1] !== "$" && !isEscaped(text, index)) {
    return { open: "$", close: "$", block: false, allowNewlines: false };
  }
  return null;
}

function findClosingMathDelimiter(
  text: string,
  start: number,
  delimiter: string,
  allowNewlines: boolean,
): number {
  for (let index = start; index < text.length; index += 1) {
    if (!allowNewlines && text[index] === "\n") return -1;
    if (!text.startsWith(delimiter, index) || isEscaped(text, index)) continue;
    if (delimiter === "$" && (text[index - 1] === "$" || text[index + 1] === "$")) continue;
    return index;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/*  Codex JSONL event parsing                                         */
/* ------------------------------------------------------------------ */

export interface CodexEvent {
  type: string;
  raw: Record<string, unknown>;
}

export interface ThreadStartedEvent extends CodexEvent {
  type: "thread.started";
  threadId: string;
}

export interface ItemCompletedEvent extends CodexEvent {
  type: "item.completed";
  itemType: string;
  text: string;
  itemId: string;
}

export interface TurnCompletedEvent extends CodexEvent {
  type: "turn.completed";
  usage: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

export interface ErrorEvent extends CodexEvent {
  type: "error" | "turn.failed";
  message: string;
}

export type ParsedCodexEvent =
  | ThreadStartedEvent
  | ItemCompletedEvent
  | TurnCompletedEvent
  | ErrorEvent
  | CodexEvent;

/**
 * Defensively parse a single JSONL line from Codex CLI.
 * Returns null on parse failure or unrecognized format.
 */
export function parseCodexJsonlLine(line: string): ParsedCodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
      return null;
    }
    switch (obj.type) {
      case "thread.started": {
        const threadId = obj.thread_id || obj.threadId || "";
        if (!threadId) return null;
        return { type: "thread.started", threadId, raw: obj };
      }
      case "item.completed": {
        const item = obj.item;
        if (!item || typeof item !== "object") return null;
        const text = typeof item.text === "string" ? item.text : "";
        const itemType = typeof item.type === "string" ? item.type : "";
        const itemId = typeof item.id === "string" ? item.id : "";
        return { type: "item.completed", itemType, text, itemId, raw: obj };
      }
      case "turn.completed": {
        const usage = obj.usage && typeof obj.usage === "object" ? obj.usage : {};
        return {
          type: "turn.completed",
          usage: {
            input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            cached_input_tokens: typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : undefined,
            output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            reasoning_output_tokens: typeof usage.reasoning_output_tokens === "number" ? usage.reasoning_output_tokens : undefined,
          },
          raw: obj,
        };
      }
      case "error": {
        const msg = typeof obj.message === "string" ? obj.message : "Unknown error";
        return { type: "error", message: msg, raw: obj };
      }
      case "turn.failed": {
        const err = obj.error;
        const msg = err && typeof err === "object" && typeof err.message === "string"
          ? err.message
          : typeof obj.message === "string"
            ? obj.message
            : "Turn failed";
        return { type: "turn.failed", message: msg, raw: obj };
      }
      case "turn.started":
        return { type: "turn.started", raw: obj };
      default:
        return { type: obj.type, raw: obj };
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Session ID validation                                             */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return true if sessionId looks like an invalid resume target.
 * A valid Codex session ID is a UUID.
 */
export function looksLikeInvalidResume(sessionId: string | null | undefined): boolean {
  if (!sessionId) return true;
  return !UUID_RE.test(sessionId);
}

/**
 * Check whether a DOM Selection's anchor and focus nodes are both
 * descendants of the given container element.
 * Returns false when the selection is empty, null, or lives outside
 * the container (e.g. in the sidebar, chat input, or another pane).
 */
export function isSelectionInsideContainer(
  container: any,
  anchorNode: any,
  focusNode: any,
): boolean {
  if (!container || typeof container.contains !== "function") return false;
  if (!anchorNode || !focusNode) return false;
  return container.contains(anchorNode) && container.contains(focusNode);
}

/* ------------------------------------------------------------------ */
/*  Status classification                                             */
/* ------------------------------------------------------------------ */

export type FinalStatus = "success" | "cancelled" | "timeout" | "spawn-error" | "process-error" | "error" | "no-result";

/**
 * Classify the final outcome of a Codex exec run.
 */
export function classifyFinalStatus(opts: {
  exitCode: number | null;
  signal: string | null;
  hasThreadStarted: boolean;
  hasTurnCompleted: boolean;
  hasError: boolean;
  errorMessage?: string;
  timedOut: boolean;
  spawnFailed: boolean;
}): FinalStatus {
  if (opts.spawnFailed) return "spawn-error";
  if (opts.timedOut) return "timeout";
  if (opts.signal === "SIGTERM" || opts.signal === "SIGKILL") return "cancelled";
  if (opts.hasError) return "error";
  if (opts.exitCode !== 0 && opts.exitCode !== null) return "process-error";
  if (!opts.hasThreadStarted) return "no-result";
  if (!opts.hasTurnCompleted) return "process-error";
  return "success";
}

/* ------------------------------------------------------------------ */
/*  Context chip building                                             */
/* ------------------------------------------------------------------ */

export interface ContextChip {
  type: "selection" | "pdf-selection" | "file" | "image" | "message-quote";
  label: string;
  data: string;         // file content, selection text, or quoted message text
  sourcePath: string;   // vault-relative path or chat:// quote source
  lines?: string;       // "5-12" for selection, page for pdf-selection
  mime?: string;
  sizeBytes?: number;
  thumbnail?: string;   // data URL for image preview
}

/**
 * Build an XML context prompt from chips.
 */
export function buildContextPrompt(
  chips: ContextChip[],
  maxFileChars: number,
  maxTotalChars: number,
): string {
  if (chips.length === 0) return "";

  const parts: string[] = [];
  let totalChars = 0;

  for (const chip of chips) {
    if (totalChars >= maxTotalChars) break;

    const truncated = truncateText(chip.data, maxFileChars);
    totalChars += truncated.length;

    if (chip.type === "selection") {
      const lineAttr = chip.lines ? ` lines="${chip.lines}"` : "";
      parts.push(
        `<selected_text path="${escapeXml(chip.sourcePath)}"${lineAttr}>\n${escapeXml(truncated)}\n</selected_text>`
      );
    } else if (chip.type === "pdf-selection") {
      const page = chip.lines || "unknown";
      parts.push(
        `<pdf_selection path="${escapeXml(chip.sourcePath)}" page="${escapeXml(page)}">\n${escapeXml(truncated)}\n</pdf_selection>`
      );
    } else if (chip.type === "message-quote") {
      const role = quotedMessageRoleFromSource(chip.sourcePath);
      parts.push(
        `<quoted_message role="${role}">\n${escapeXml(truncated)}\n</quoted_message>`
      );
    } else if (chip.type === "file") {
      parts.push(
        `<file_context path="${escapeXml(chip.sourcePath)}">\n${escapeXml(truncated)}\n</file_context>`
      );
    } else if (chip.type === "image") {
      parts.push(
        `<image path="${escapeXml(chip.sourcePath)}" mime="${escapeXml(chip.mime || "")}" />\n`
      );
    }
  }

  if (parts.length === 0) return "";
  return `<context>\n${parts.join("\n\n")}\n</context>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quotedMessageRoleFromSource(sourcePath: string): "assistant" | "user" {
  return sourcePath.includes("/user/") ? "user" : "assistant";
}

/* ------------------------------------------------------------------ */
/*  File filtering for @ mentions                                     */
/* ------------------------------------------------------------------ */

interface FileEntry {
  path: string;
  name: string;
  extension: string;
}

/**
 * Filter and sort vault files matching a query for @ mentions.
 */
export function getSupportedFiles(
  files: FileEntry[],
  query: string,
): FileEntry[] {
  const q = query.toLowerCase();

  const filtered = files.filter((f) => {
    if (!SUPPORTED_EXTENSIONS.has(f.extension.toLowerCase())) return false;
    if (!q) return true;
    return f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
  });

  filtered.sort((a, b) => {
    // Exact basename match first
    const aExact = a.name.toLowerCase() === q ? 0 : 1;
    const bExact = b.name.toLowerCase() === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    // Then partial match on name
    const aNameMatch = a.name.toLowerCase().includes(q) ? 0 : 1;
    const bNameMatch = b.name.toLowerCase().includes(q) ? 0 : 1;
    if (aNameMatch !== bNameMatch) return aNameMatch - bNameMatch;

    // Then by extension rank
    const aRank = EXTENSION_RANK[a.extension.toLowerCase()] ?? 99;
    const bRank = EXTENSION_RANK[b.extension.toLowerCase()] ?? 99;
    if (aRank !== bRank) return aRank - bRank;

    // Alphabetical
    return a.path.localeCompare(b.path);
  });

  return filtered;
}

/* ------------------------------------------------------------------ */
/*  Utility functions                                                 */
/* ------------------------------------------------------------------ */

export function fileTypeBadge(ext: string): string {
  const e = ext.toLowerCase();
  if (IMAGE_EXTENSIONS.has(e)) return "IMG";
  if (e === "pdf") return "PDF";
  if (e === "md") return "MD";
  return e.toUpperCase().slice(0, 3);
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... [truncated]";
}

export function generateTitle(text: string): string {
  const clean = text.replace(/<context>[\s\S]*?<\/context>/g, "").trim();
  const first = clean.split("\n")[0] || clean;
  const title = first.slice(0, 50);
  return title || "New Chat";
}

export function cloneMessage<T>(msg: T): T {
  return JSON.parse(JSON.stringify(msg));
}

export function extractMentionedPaths(text: string): string[] {
  const paths: string[] = [];
  // Match @path patterns (but not email addresses)
  const re = /(?:^|\s)@((?:[^\s@][\w./-]*)\.[\w]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

export function formatContextSummary(chips: ContextChip[]): string {
  if (chips.length === 0) return "";
  const parts = chips.map((c) => {
    if (c.type === "selection") return `selection from ${c.sourcePath}`;
    if (c.type === "pdf-selection") return `PDF selection from ${c.sourcePath}`;
    if (c.type === "file") return c.sourcePath;
    if (c.type === "image") return `image: ${c.sourcePath}`;
    if (c.type === "message-quote") return `quote from ${quotedMessageRoleFromSource(c.sourcePath)}`;
    return c.label;
  });
  return parts.join(", ");
}

export function isImageFilePath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function appendPartialWarning(content: string): string {
  return content + "\n\n> ⚠️ This response was cancelled or interrupted and may be incomplete.";
}

export interface ModelCatalogEntry {
  slug: string;
  displayName: string;
  supportedReasoningLevels: string[];
  defaultReasoningLevel?: string;
}

export const CODEX_APP_ENABLED_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "ultra"];

const EFFORT_DISPLAY_LABELS: Record<string, string> = {
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

export function getEffortDisplayLabel(effort: string): string {
  return EFFORT_DISPLAY_LABELS[effort] || effort;
}

export function parseModelsJson(jsonStr: string): ModelCatalogEntry[] {
  try {
    const obj = JSON.parse(jsonStr);
    if (obj && Array.isArray(obj.models)) {
      return obj.models
        .filter((m: any) => m && m.visibility === "list")
        .map((m: any) => {
          const supportedReasoningLevels = Array.isArray(m.supported_reasoning_levels)
            ? m.supported_reasoning_levels.map((r: any) => typeof r === "string" ? r : r.effort)
            : [];
          return {
            slug: m.slug,
            displayName: m.display_name || m.slug,
            supportedReasoningLevels,
            defaultReasoningLevel: m.default_reasoning_level,
          };
        });
    }
  } catch (e) {
    // ignore
  }
  return [];
}

export function getFallbackModelCatalog(): ModelCatalogEntry[] {
  return [
    { slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningLevel: "medium" },
    { slug: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningLevel: "medium" },
    { slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoningLevel: "medium" },
    { slug: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" },
    { slug: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" },
    { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" }
  ];
}

export function getEffortOptionsForModel(slug: string, catalog: ModelCatalogEntry[]): string[] {
  if (!slug) {
    return ["default"];
  }
  const model = (catalog || []).find((m) => m.slug === slug);
  if (!model) {
    return ["default"];
  }
  return model.supportedReasoningLevels.filter((effort) => CODEX_APP_ENABLED_REASONING_EFFORTS.includes(effort));
}

export function getImageOnlyPromptAndDisplay(hasImages: boolean, rawText: string): { prompt: string; displayContent: string; isImageOnly: boolean } {
  const trimmed = (rawText || "").trim();
  const isImageOnly = !trimmed && hasImages;
  return {
    prompt: isImageOnly ? "Please inspect the attached image." : trimmed,
    displayContent: isImageOnly ? "[image attachment]" : trimmed,
    isImageOnly
  };
}

export function imageSrcForPath(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/**
 * Recognize the narrow local-link shape emitted by Codex file citations.
 *
 * Only absolute Markdown paths inside the current vault are accepted. Web
 * URLs, relative links, paths outside the vault, and non-Markdown files are
 * intentionally left for Obsidian's normal renderer.
 */
export function vaultMarkdownPathFromHref(href: string, vaultRoot: string): string | null {
  const raw = (href || "").trim();
  if (!raw || !vaultRoot) return null;

  let candidate: string;
  try {
    if (raw.startsWith("file://")) {
      candidate = fileURLToPath(raw);
    } else if (raw.startsWith("/")) {
      candidate = raw;
    } else {
      return null;
    }
    candidate = decodeURIComponent(candidate);
  } catch {
    return null;
  }

  // Codex file citations may append a source line, e.g. "/note.md:9".
  candidate = candidate.replace(/:(\d+)(?:-\d+)?$/, "");
  if (!isAbsolute(candidate)) return null;

  const root = resolve(vaultRoot);
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (!rel.toLowerCase().endsWith(".md")) return null;

  return rel.split(sep).join("/");
}
