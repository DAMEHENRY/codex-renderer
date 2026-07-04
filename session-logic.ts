/**
 * session-logic.ts — Pure logic for Codex Renderer.
 *
 * No DOM, no Obsidian imports, no side effects. Every function here is
 * deterministic and unit-testable from a CJS test bundle.
 */

import { pathToFileURL } from "url";

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

/* ------------------------------------------------------------------ */
/*  Codex CLI argument builders                                       */
/* ------------------------------------------------------------------ */

/**
 * Build `-c model_reasoning_effort="<value>"` args.
 * Returns empty array for "default" (don't override).
 */
export function buildReasoningEffortArg(effort: string): string[] {
  if (!effort || effort === "default") return [];
  const valid = ["none", "minimal", "low", "medium", "high", "xhigh"];
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
    { slug: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningLevels: ["none", "low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" },
    { slug: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningLevels: ["none", "low", "medium", "high", "xhigh"], defaultReasoningLevel: "low" },
    { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["none", "low", "medium", "high", "xhigh"], defaultReasoningLevel: "low" }
  ];
}

export function getEffortOptionsForModel(slug: string, catalog: ModelCatalogEntry[]): string[] {
  if (!slug) {
    return ["default", "none", "minimal", "low", "medium", "high", "xhigh"];
  }
  const model = (catalog || []).find((m) => m.slug === slug);
  if (!model) {
    return ["default", "low", "medium", "high", "xhigh"];
  }
  return ["default", ...model.supportedReasoningLevels];
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
