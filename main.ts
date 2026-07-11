/**
 * main.ts — Codex Renderer: thin Obsidian UI for the official Codex CLI.
 *
 * Architecture:
 *   main.ts          — Plugin lifecycle, settings, views (this file)
 *   codex-bridge.ts  — Spawn/manage codex CLI child processes
 *   session-logic.ts — Pure logic (no DOM, no Obsidian deps)
 *
 * Official Codex history (~/.codex/sessions/) is the source of truth.
 * The local history.json here is a UI convenience cache only.
 */

import {
  App,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import * as path from "path";
import {
  sendPrompt,
  killCodexProcess,
  isCodexRunning,
  resolveCodexPath,
  fetchModelCatalog,
  type CodexBridgeSettings,
  type CodexStreamEvent,
} from "./codex-bridge";
import {
  buildContextPrompt,
  getSupportedFiles,
  fileTypeBadge,
  truncateText,
  generateTitle,
  cloneMessage,
  extractMentionedPaths,
  formatContextSummary,
  isImageFilePath,
  appendPartialWarning,
  IMAGE_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  looksLikeInvalidResume,
  isSelectionInsideContainer,
  getFallbackModelCatalog,
  getEffortOptionsForModel,
  getEffortDisplayLabel,
  getImageOnlyPromptAndDisplay,
  imageSrcForPath,
  type ContextChip,
} from "./session-logic";

/* ================================================================== */
/*  Constants                                                         */
/* ================================================================== */

const VIEW_TYPE = "codex-renderer-view";
const VIEW_ICON = "terminal";
const MAX_CONVERSATIONS = 20;
const WRITE_DEBOUNCE_MS = 500;
const SELECTION_POLL_MS = 250;

/* ================================================================== */
/*  Settings                                                          */
/* ================================================================== */

export interface CodexRendererSettings {
  codexCliPath: string;
  modelPresets: string[];
  modelCatalog: any[];
  selectedModel: string;
  reasoningEffort: string;
  webSearchMode: string;
  sandboxMode: string;
  approvalPolicy: string;
  requestTimeoutMinutes: number;
  maxFileContextChars: number;
  maxTotalContextChars: number;
  viewPlacement: string;
}

const DEFAULT_SETTINGS: CodexRendererSettings = {
  codexCliPath: "codex",
  modelPresets: getFallbackModelCatalog().map((m) => m.slug),
  modelCatalog: getFallbackModelCatalog(),
  selectedModel: "",
  reasoningEffort: "default",
  webSearchMode: "off",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  requestTimeoutMinutes: 20,
  maxFileContextChars: 20000,
  maxTotalContextChars: 100000,
  viewPlacement: "right",
};

/* ================================================================== */
/*  Interfaces                                                        */
/* ================================================================== */

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  displayContent: string;
  timestamp: number;
  sendStatus: SendStatus;
  contextAttachments: ContextChip[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

type SendStatus =
  | "idle"
  | "success"
  | "cancelled"
  | "timeout"
  | "spawn-error"
  | "process-error"
  | "error"
  | "no-result"
  | "pending";

interface Conversation {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastModel: string;
  lastEffort?: string;
  messages: ChatMessage[];
}

/* ================================================================== */
/*  History Store                                                     */
/* ================================================================== */

class HistoryStore {
  private conversations: Conversation[] = [];
  private path: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: App) {
    // @ts-ignore
    const base = app.vault.adapter?.basePath || process.cwd();
    this.path = path.join(base, ".obsidian", "plugins", "codex-renderer", "history.json");
  }

  load(): void {
    try {
      const fs = require("fs");
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, "utf-8");
        this.conversations = JSON.parse(raw);
        if (!Array.isArray(this.conversations)) this.conversations = [];
      } else {
        this.conversations = [];
      }
    } catch (e) {
      console.error("Codex Renderer: failed to read history.json", e);
      this.conversations = [];
    }
  }

  getConversations(): Conversation[] {
    return cloneMessage(this.conversations);
  }

  save(conversations: Conversation[]): void {
    this.conversations = cloneMessage(conversations);
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.atomicWrite();
    }, WRITE_DEBOUNCE_MS);
  }

  flushNow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.atomicWrite();
  }

  private atomicWrite(): void {
    try {
      const fs = require("fs");
      const dir = path.dirname(this.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = this.path + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(this.conversations, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.path);
    } catch (e) {
      console.error("Codex Renderer: failed to write history.json", e);
    }
  }
}

/* ================================================================== */
/*  Markdown Render Queue                                             */
/* ================================================================== */

const renderStateMap = new WeakMap<HTMLElement, { version: number; token: number }>();
const renderQueue: Array<() => Promise<void>> = [];
let renderRunning = false;
let renderTokenCounter = 0;

function enqueueRender(
  md: string,
  el: HTMLElement,
  sourcePath: string,
  app: App,
  version: number,
): void {
  const token = ++renderTokenCounter;
  renderStateMap.set(el, { version, token });
  renderQueue.push(async () => {
    const state = renderStateMap.get(el);
    if (!state || state.version !== version || state.token !== token) return;
    try {
      el.innerHTML = "";
      await MarkdownRenderer.render(app, md, el, sourcePath, undefined as any);
      const latestState = renderStateMap.get(el);
      if (!latestState || latestState.version !== version || latestState.token !== token) return;
      postProcessWikilinks(el, app);
    } catch {
      const latestState = renderStateMap.get(el);
      if (latestState && latestState.version === version && latestState.token === token) {
        el.setText(md);
      }
    }
  });
  drainRenderQueue();
}

async function drainRenderQueue(): Promise<void> {
  if (renderRunning) return;
  renderRunning = true;
  while (renderQueue.length > 0) {
    const fn = renderQueue.shift()!;
    await fn();
  }
  renderRunning = false;
}

/* ================================================================== */
/*  Wikilink post-processing                                          */
/* ================================================================== */

function postProcessWikilinks(el: HTMLElement, app: App): void {
  // Pass 1: Obsidian-generated internal-link anchors
  const anchors = el.querySelectorAll("a.internal-link");
  anchors.forEach((a) => {
    const href = a.getAttribute("data-href") || a.getAttribute("href") || a.textContent || "";
    if (!href) return;
    a.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      app.workspace.openLinkText(href, "", "tab");
    });
  });

  // Pass 2: Raw [[wikilinks]] in text nodes
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.parentElement) {
      const tag = node.parentElement.tagName.toLowerCase();
      if (tag === "pre" || tag === "code" || tag === "a") continue;
    }
    if (node.textContent && node.textContent.includes("[[")) {
      textNodes.push(node);
    }
  }
  for (const tn of textNodes) {
    const text = tn.textContent || "";
    const regex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const linkTarget = m[1];
      const display = m[2] || m[1];
      const a = document.createElement("a");
      a.className = "internal-link cx-wikilink";
      a.textContent = display;
      a.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        app.workspace.openLinkText(linkTarget, "", "tab");
      });
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    if (last > 0) {
      tn.parentNode?.replaceChild(frag, tn);
    }
  }
}

/* ================================================================== */
/*  Utility                                                           */
/* ================================================================== */

function formatRelativeDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const dayMs = 86400000;
  if (diff < dayMs && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < 2 * dayMs) return "Yesterday";
  if (diff < 7 * dayMs) return `${Math.floor(diff / dayMs)}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ================================================================== */
/*  Plugin                                                            */
/* ================================================================== */

export default class CodexRendererPlugin extends Plugin {
  settings!: CodexRendererSettings;
  historyStore!: HistoryStore;
  private freshChatLeaves = new WeakSet<WorkspaceLeaf>();

  async onload(): Promise<void> {
    await this.loadSettings();

    if (!this.settings.modelCatalog || this.settings.modelCatalog.length === 0) {
      this.settings.modelCatalog = getFallbackModelCatalog();
      this.settings.modelPresets = this.settings.modelCatalog.map((m) => m.slug);
      await this.saveSettings();
    }
    this.refreshModelCatalogQuietly();

    this.historyStore = new HistoryStore(this.app);
    this.historyStore.load();

    this.registerView(VIEW_TYPE, (leaf) => new CodexChatView(leaf, this));

    const ribbonEl = this.addRibbonIcon(VIEW_ICON, "Open New Codex Chat Window", () => {
      this.activateNewView();
    });
    ribbonEl.setAttribute("aria-label", "Open New Codex Chat Window");

    this.addCommand({
      id: "open-codex-chat",
      name: "Open Codex Chat",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-new-codex-chat-window",
      name: "Open New Codex Chat Window",
      callback: () => this.activateNewView(),
    });

    this.addSettingTab(new CodexRendererSettingTab(this.app, this));
  }

  async refreshModelCatalogQuietly(): Promise<void> {
    console.log("Codex Renderer: refreshing model catalog from Codex CLI...");
    try {
      const catalog = await fetchModelCatalog(this.settings.codexCliPath);
      if (catalog && catalog.length > 0) {
        this.settings.modelCatalog = catalog;
        this.settings.modelPresets = catalog.map((m) => m.slug);
        await this.saveSettings();
        console.log(`Codex Renderer: successfully loaded ${catalog.length} models from Codex CLI.`);

        this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
          if (leaf.view instanceof CodexChatView) {
            leaf.view.updateModelDropdownOptions();
          }
        });
      } else {
        console.warn("Codex Renderer: fetchModelCatalog returned empty or null. Using fallback models.");
      }
    } catch (err) {
      console.error("Codex Renderer: failed to refresh model catalog from Codex CLI", err);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    if (this.historyStore) {
      this.historyStore.flushNow();
    }
  }

  activateView(): void {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const placement = this.settings.viewPlacement;
      if (placement === "left") {
        leaf = workspace.getLeftLeaf(false);
      } else if (placement === "tab") {
        leaf = workspace.getLeaf("tab");
      } else {
        leaf = workspace.getRightLeaf(false);
      }
      if (leaf) leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  async activateNewView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    try {
      leaf = workspace.getRightLeaf(true);
    } catch {}
    if (!leaf) leaf = workspace.getLeaf("tab");
    if (!leaf) return;

    this.freshChatLeaves.add(leaf);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: { freshChat: true },
    });
    workspace.revealLeaf(leaf);
  }

  consumeFreshChatLeaf(leaf: WorkspaceLeaf): boolean {
    const isFresh = this.freshChatLeaves.has(leaf);
    if (isFresh) this.freshChatLeaves.delete(leaf);
    return isFresh;
  }
}

/* ================================================================== */
/*  Settings Tab                                                      */
/* ================================================================== */

class CodexRendererSettingTab extends PluginSettingTab {
  plugin: CodexRendererPlugin;

  constructor(app: App, plugin: CodexRendererPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Codex Renderer Settings" });

    new Setting(containerEl)
      .setName("Codex CLI path")
      .setDesc("Path to the codex binary. Leave 'codex' to auto-discover.")
      .addText((t) =>
        t
          .setPlaceholder("codex")
          .setValue(this.plugin.settings.codexCliPath)
          .onChange(async (v) => {
            this.plugin.settings.codexCliPath = v.trim() || "codex";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Model presets")
      .setDesc("One model name per line. These appear as fallback in the model dropdown if catalog is empty.")
      .addTextArea((t) =>
        t
          .setPlaceholder("gpt-5.5\ngpt-5.4\ngpt-5.4-mini")
          .setValue(this.plugin.settings.modelPresets.join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.modelPresets = v
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Refresh models from Codex")
      .setDesc("Fetch the latest model catalog dynamically from the local Codex CLI config.")
      .addButton((b) =>
        b
          .setButtonText("Refresh models")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            b.setButtonText("Refreshing...");
            try {
              const catalog = await fetchModelCatalog(this.plugin.settings.codexCliPath);
              if (catalog && catalog.length > 0) {
                this.plugin.settings.modelCatalog = catalog;
                this.plugin.settings.modelPresets = catalog.map((m) => m.slug);
                await this.plugin.saveSettings();
                new Notice(`Loaded ${catalog.length} models from Codex!`);
                this.display();
              } else {
                new Notice("No models returned by Codex CLI.");
              }
            } catch (err) {
              new Notice(`Failed to refresh models: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              b.setDisabled(false);
              b.setButtonText("Refresh models");
            }
          })
      );

    const isFallback = !this.plugin.settings.modelCatalog || this.plugin.settings.modelCatalog.length === 0 || 
      JSON.stringify(this.plugin.settings.modelCatalog) === JSON.stringify(getFallbackModelCatalog());

    new Setting(containerEl)
      .setName("Model catalog status")
      .setDesc(isFallback ? "⚠️ Using fallback model catalog. Click 'Refresh models' to fetch from local Codex CLI." : `✅ Loaded ${this.plugin.settings.modelCatalog.length} models from Codex CLI.`);

    new Setting(containerEl)
      .setName("Selected model")
      .setDesc("Model to use. 'Default' means do not pass -m (uses Codex config).")
      .addDropdown((d) => {
        d.addOption("", "Default");
        const catalog = this.plugin.settings.modelCatalog || [];
        if (catalog.length > 0) {
          for (const m of catalog) {
            d.addOption(m.slug, m.displayName);
          }
        } else {
          for (const m of this.plugin.settings.modelPresets) {
            d.addOption(m, m);
          }
        }
        d.setValue(this.plugin.settings.selectedModel);
        d.onChange(async (v) => {
          this.plugin.settings.selectedModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Reasoning effort")
      .setDesc("Override model_reasoning_effort using the same labels as the ChatGPT Codex UI. 'Use Codex default' passes no override.")
      .addDropdown((d) => {
        d.addOption("default", "Use Codex default");
        for (const effort of ["low", "medium", "high", "xhigh", "ultra"]) {
          d.addOption(effort, getEffortDisplayLabel(effort));
        }
        d.setValue(this.plugin.settings.reasoningEffort);
        d.onChange(async (v) => {
          this.plugin.settings.reasoningEffort = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Web search")
      .setDesc("Enable Codex's built-in web search tool.")
      .addDropdown((d) => {
        d.addOption("off", "Off");
        d.addOption("search", "Search");
        d.setValue(this.plugin.settings.webSearchMode);
        d.onChange(async (v) => {
          this.plugin.settings.webSearchMode = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Sandbox mode")
      .setDesc("Codex sandbox mode for file access.")
      .addDropdown((d) => {
        d.addOption("workspace-write", "workspace-write");
        d.addOption("read-only", "read-only");
        d.addOption("danger-full-access", "danger-full-access");
        d.setValue(this.plugin.settings.sandboxMode);
        d.onChange(async (v) => {
          this.plugin.settings.sandboxMode = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Request timeout (minutes)")
      .setDesc("Max minutes to wait for Codex CLI to respond.")
      .addText((t) =>
        t
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.requestTimeoutMinutes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.requestTimeoutMinutes = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("View placement")
      .setDesc("Where to open the Codex chat pane.")
      .addDropdown((d) => {
        d.addOption("right", "Right sidebar");
        d.addOption("left", "Left sidebar");
        d.addOption("tab", "Tab");
        d.setValue(this.plugin.settings.viewPlacement);
        d.onChange(async (v) => {
          this.plugin.settings.viewPlacement = v;
          await this.plugin.saveSettings();
        });
      });
  }
}

/* ================================================================== */
/*  History Modal                                                     */
/* ================================================================== */

class HistoryModal extends Modal {
  private conversations: Conversation[];
  private onSelect: (conv: Conversation) => void;
  private onDelete: (conv: Conversation) => void;

  constructor(
    app: App,
    conversations: Conversation[],
    onSelect: (conv: Conversation) => void,
    onDelete: (conv: Conversation) => void,
  ) {
    super(app);
    this.conversations = conversations;
    this.onSelect = onSelect;
    this.onDelete = onDelete;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Chat History" });

    if (this.conversations.length === 0) {
      contentEl.createEl("p", { text: "No conversations yet." });
      return;
    }

    const list = contentEl.createDiv({ cls: "cx-history-list" });

    for (const conv of this.conversations) {
      const row = list.createDiv({ cls: "cx-history-row" });

      const info = row.createDiv({ cls: "cx-history-info" });
      info.createEl("span", { text: conv.title, cls: "cx-history-title" });
      const meta = info.createDiv({ cls: "cx-history-meta" });
      meta.createEl("span", { text: formatRelativeDate(conv.updatedAt) });
      if (conv.lastModel) {
        meta.createEl("span", { text: conv.lastModel, cls: "cx-history-model" });
      }

      const cmdRow = info.createDiv({ cls: "cx-history-cmd-row" });
      cmdRow.createEl("span", { text: `ID: ${conv.sessionId.slice(0, 8)}`, cls: "cx-history-session-id" });
      
      const copyBtn = cmdRow.createEl("button", { text: "Copy Resume", cls: "cx-history-copy-btn" });
      copyBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const cmd = `codex exec resume ${conv.sessionId} "prompt"`;
        navigator.clipboard.writeText(cmd);
        new Notice("Copied resume command!");
      });

      const copyBtn2 = cmdRow.createEl("button", { text: "Copy CLI Resume", cls: "cx-history-copy-btn" });
      copyBtn2.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const cmd = `codex resume --include-non-interactive ${conv.sessionId}`;
        navigator.clipboard.writeText(cmd);
        new Notice("Copied CLI resume command!");
      });

      const trashBtn = row.createEl("button", {
        cls: "cx-history-trash",
      });
      trashBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.onDelete(conv);
        row.remove();
      });

      row.addEventListener("click", () => {
        this.close();
        this.onSelect(conv);
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* ================================================================== */
/*  Image Preview Modal                                               */
/* ================================================================== */

class ImagePreviewModal extends Modal {
  private src: string;
  private absPath: string;
  private displayPath: string;

  constructor(app: App, src: string, absPath: string, displayPath: string) {
    super(app);
    this.src = src;
    this.absPath = absPath;
    this.displayPath = displayPath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cx-image-preview-modal");

    const img = contentEl.createEl("img", { cls: "cx-image-preview-full" });
    img.src = this.src;

    const pathRow = contentEl.createDiv({ cls: "cx-image-preview-path" });
    pathRow.createSpan({ text: this.displayPath });

    const btnRow = contentEl.createDiv({ cls: "cx-image-preview-actions" });
    const openBtn = btnRow.createEl("button", {
      text: "Open original",
      cls: "cx-image-preview-open-btn mod-cta",
    });
    openBtn.addEventListener("click", () => this.openOriginal());
  }

  onClose() {
    this.contentEl.empty();
  }

  private async openOriginal() {
    try {
      const adapter = (this.app as any).vault?.adapter;
      const base = adapter?.basePath;
      if (base) {
        const path = require("path");
        const rel = path.relative(base, this.absPath);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
          const abstractFile = this.app.vault.getAbstractFileByPath(rel);
          if (abstractFile instanceof TFile) {
            await this.app.workspace.getLeaf("tab").openFile(abstractFile);
            this.close();
            return;
          }
        }
      }
      const { shell } = require("electron");
      if (shell) {
        shell.openPath(this.absPath);
      }
    } catch {}
    this.close();
  }
}

/* ================================================================== */
/*  CodexChatView                                                     */
/* ================================================================== */

class CodexChatView extends ItemView {
  private plugin: CodexRendererPlugin;

  // DOM elements
  private wrapperEl!: HTMLDivElement;
  private chatEl!: HTMLDivElement;
  private welcomeEl!: HTMLDivElement;
  private chipsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private mentionDropdown!: HTMLDivElement;
  private modelSelect!: HTMLSelectElement;
  private effortSelect!: HTMLSelectElement;
  private modelMenuBtn!: HTMLButtonElement;
  private effortMenuBtn!: HTMLButtonElement;
  private modelMenuEl!: HTMLDivElement;
  private effortMenuEl!: HTMLDivElement;
  private sendBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private newChatBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private quotePopoverEl!: HTMLButtonElement;

  // State
  private messages: ChatMessage[] = [];
  private chips: ContextChip[] = [];
  private preservedSelection: { text: string; path: string; lines: string } | null = null;
  private preservedPdfSelection: { text: string; path: string; page: string } | null = null;
  private isStreaming = false;
  private sessionId: string | null = null;
  private mentionQuery = "";
  private mentionIndex = 0;
  private mentionResults: Array<{ path: string; name: string; extension: string }> = [];
  private mentionActive = false;
  private messageVersion = 0;
  private selectionInterval: ReturnType<typeof setInterval> | null = null;
  private pendingQuote: ContextChip | null = null;
  private quoteSelectionTimer: number | null = null;
  private skipInitialRestore: boolean;

  constructor(leaf: WorkspaceLeaf, plugin: CodexRendererPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.skipInitialRestore = plugin.consumeFreshChatLeaf(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Codex Chat";
  }

  getIcon(): string {
    return VIEW_ICON;
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("codex-renderer-view");

    const wrapper = container.createDiv({ cls: "cx-wrapper" });
    this.wrapperEl = wrapper;

    // Chat area
    const chatFrame = wrapper.createDiv({ cls: "cx-chat-frame" });
    this.chatEl = chatFrame.createDiv({ cls: "cx-chat" });
    this.welcomeEl = this.chatEl.createDiv({ cls: "cx-welcome" });
    this.welcomeEl.createEl("p", { text: "Welcome to Codex Renderer" });
    this.welcomeEl.createEl("p", {
      text: "This plugin uses the official Codex CLI with your ChatGPT subscription. No API keys needed.",
      cls: "cx-welcome-sub",
    });

    this.quotePopoverEl = document.createElement("button");
    this.quotePopoverEl.className = "cx-quote-popover";
    this.quotePopoverEl.textContent = "Quote";
    this.quotePopoverEl.type = "button";
    this.quotePopoverEl.style.display = "none";
    this.quotePopoverEl.addEventListener("mousedown", (evt) => evt.preventDefault());
    this.quotePopoverEl.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.acceptPendingQuote();
    });
    document.body.appendChild(this.quotePopoverEl);

    // Context chips
    this.chipsEl = wrapper.createDiv({ cls: "cx-chips" });
    this.chipsEl.style.display = "none";

    // Status line
    this.statusEl = wrapper.createDiv({ cls: "cx-status" });
    this.statusEl.style.display = "none";

    // Input area
    const inputArea = wrapper.createDiv({ cls: "cx-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "cx-input",
      placeholder: "Message Codex… (use @ to mention files)",
    });
    this.inputEl.rows = 1;

    // Mention dropdown
    this.mentionDropdown = inputArea.createDiv({ cls: "cx-mention-dropdown" });
    this.setMentionDropdownVisible(false);

    // Unified composer toolbar row
    const toolbar = inputArea.createDiv({ cls: "cx-composer-toolbar" });

    // Model + effort row. Native selects remain as backing state for send/history.
    const modelRow = toolbar.createDiv({ cls: "cx-model-row" });

    const modelControl = modelRow.createDiv({ cls: "cx-option-control" });
    this.modelSelect = modelControl.createEl("select", { cls: "cx-model-select cx-native-select" });
    this.modelMenuBtn = modelControl.createEl("button", { cls: "cx-option-btn cx-model-btn" });
    this.modelMenuBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect><path d="M9 1v3"></path><path d="M15 1v3"></path><path d="M9 20v3"></path><path d="M15 20v3"></path><path d="M20 9h3"></path><path d="M20 14h3"></path><path d="M1 9h3"></path><path d="M1 14h3"></path></svg>`;
    this.modelMenuBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.toggleOptionMenu("model");
    });
    this.modelMenuEl = modelControl.createDiv({ cls: "cx-option-menu cx-model-menu" });
    this.modelMenuEl.style.display = "none";

    const effortControl = modelRow.createDiv({ cls: "cx-option-control" });
    this.effortSelect = effortControl.createEl("select", { cls: "cx-effort-select cx-native-select" });
    this.effortMenuBtn = effortControl.createEl("button", { cls: "cx-option-btn cx-effort-btn" });
    this.effortMenuBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14l3.5-3.5"></path><path d="M4.2 19a9 9 0 1 1 15.6 0"></path><path d="M12 4v2"></path><path d="M4.9 7.6l1.4 1.4"></path><path d="M19.1 7.6l-1.4 1.4"></path></svg>`;
    this.effortMenuBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.toggleOptionMenu("effort");
    });
    this.effortMenuEl = effortControl.createDiv({ cls: "cx-option-menu cx-effort-menu" });
    this.effortMenuEl.style.display = "none";

    this.updateModelDropdownOptions();

    this.modelSelect.addEventListener("change", () => {
      this.plugin.settings.selectedModel = this.modelSelect.value;
      this.plugin.saveSettings();
      this.updateEffortDropdownOptions();
      this.closeOptionMenus();
    });

    this.effortSelect.addEventListener("change", () => {
      this.plugin.settings.reasoningEffort = this.effortSelect.value;
      this.plugin.saveSettings();
      this.updateOptionButtonLabels();
      this.closeOptionMenus();
    });

    // Button row
    const btnRow = toolbar.createDiv({ cls: "cx-btn-row" });

    this.historyBtn = btnRow.createEl("button", { cls: "cx-history-btn" });
    this.historyBtn.title = "History";
    this.historyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
    this.historyBtn.addEventListener("click", () => this.showHistory());

    this.newChatBtn = btnRow.createEl("button", { cls: "cx-new-chat-btn" });
    this.newChatBtn.title = "New Chat";
    this.newChatBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
    this.newChatBtn.addEventListener("click", () => this.handleNewChat());

    this.sendBtn = btnRow.createEl("button", { cls: "cx-send-btn" });
    this.sendBtn.title = "Send message";
    this.sendBtn.setAttribute("aria-label", "Send message");
    this.sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
    this.sendBtn.addEventListener("click", () => this.handleSend());

    this.cancelBtn = btnRow.createEl("button", { cls: "cx-cancel-btn" });
    this.cancelBtn.title = "Stop generation";
    this.cancelBtn.setAttribute("aria-label", "Stop generation");
    this.cancelBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
    this.cancelBtn.style.display = "none";
    this.cancelBtn.addEventListener("click", () => this.handleCancel());

    // Event listeners
    this.inputEl.addEventListener("input", () => this.handleInputChange());
    this.inputEl.addEventListener("keydown", (e) => this.handleInputKeydown(e));
    this.inputEl.addEventListener("paste", (e) => this.handlePaste(e));
    this.inputEl.addEventListener("drop", (e) => this.handleDrop(e));
    this.inputEl.addEventListener("dragover", (e) => e.preventDefault());
    this.registerDomEvent(this.chatEl, "mouseup", () => this.deferChatQuoteSelection());
    this.registerDomEvent(this.chatEl, "keyup", () => this.deferChatQuoteSelection());
    this.registerDomEvent(this.chatEl, "scroll", () => this.hideQuotePopover());
    this.registerDomEvent(document, "selectionchange", () => this.deferChatQuoteSelection(80));
    this.registerDomEvent(document, "click", () => this.closeOptionMenus());
    this.registerDomEvent(document, "mousedown", (evt) => {
      const target = evt.target as Node | null;
      if (target && this.quotePopoverEl?.contains(target)) return;
      this.hideQuotePopover();
    });

    // Auto-resize
    this.inputEl.addEventListener("input", () => this.autoResizeInput());

    // Selection polling
    this.selectionInterval = setInterval(() => this.pollEditorSelection(), SELECTION_POLL_MS);

    // Restore latest conversation unless this leaf was explicitly opened as a fresh chat.
    if (!this.skipInitialRestore) {
      const conversations = this.plugin.historyStore.getConversations();
      if (conversations.length > 0) {
        this.restoreConversation(conversations[0]);
      }
    }
  }

  async onClose(): Promise<void> {
    if (this.selectionInterval) clearInterval(this.selectionInterval);
    this.hideQuotePopover();
    this.quotePopoverEl?.remove();
    this.plugin.historyStore.flushNow();
  }

  /* ------------------------------------------------------------------ */
  /*  Input handling                                                    */
  /* ------------------------------------------------------------------ */

  private autoResizeInput(): void {
    this.inputEl.style.height = "auto";
    const h = Math.min(Math.max(this.inputEl.scrollHeight, 36), 220);
    this.inputEl.style.height = h + "px";
  }

  private handleInputChange(): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart;
    const before = val.slice(0, pos);
    const match = before.match(/(^|\s)@([^\s@]*)$/);

    if (match) {
      this.mentionQuery = match[2];
      this.mentionActive = true;
      this.mentionIndex = 0;
      this.updateMentionDropdown();
    } else {
      this.closeMentionDropdown();
    }
  }

  private updateMentionDropdown(): void {
    const vault = this.app.vault;
    const files = vault.getFiles().map((f) => ({
      path: f.path,
      name: f.name,
      extension: f.extension,
    }));

    this.mentionResults = getSupportedFiles(files, this.mentionQuery).slice(0, 15);

    if (this.mentionResults.length === 0) {
      this.closeMentionDropdown();
      return;
    }

    this.mentionDropdown.empty();
    this.setMentionDropdownVisible(true);

    for (let i = 0; i < this.mentionResults.length; i++) {
      const f = this.mentionResults[i];
      const item = this.mentionDropdown.createDiv({ cls: "cx-mention-item" });
      if (i === this.mentionIndex) item.addClass("is-selected");

      const badge = item.createEl("span", { cls: "cx-mention-badge", text: fileTypeBadge(f.extension) });
      item.createEl("span", { text: f.path, cls: "cx-mention-path" });

      item.addEventListener("click", () => this.selectMention(i));
    }
  }

  private closeMentionDropdown(): void {
    this.mentionActive = false;
    this.setMentionDropdownVisible(false);
    this.mentionDropdown.empty();
  }

  private setMentionDropdownVisible(visible: boolean): void {
    this.mentionDropdown.style.display = visible ? "block" : "none";
    this.wrapperEl.classList.toggle("is-mention-open", visible);
  }

  private selectMention(index: number): void {
    const file = this.mentionResults[index];
    if (!file) return;

    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    const newBefore = before.replace(/@([^\s@]*)$/, file.path + " ");
    this.inputEl.value = newBefore + after;
    this.inputEl.selectionStart = this.inputEl.selectionEnd = newBefore.length;
    this.closeMentionDropdown();

    // Add chip
    if (isImageFilePath(file.path)) {
      this.addChip({
        type: "image",
        label: file.name,
        data: "",
        sourcePath: file.path,
        mime: `image/${file.extension}`,
      });
    } else {
      this.addChip({
        type: "file",
        label: file.name,
        data: "",
        sourcePath: file.path,
      });
    }
  }

  private handleInputKeydown(evt: KeyboardEvent): void {
    if (this.mentionActive) {
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        this.mentionIndex = Math.min(this.mentionIndex + 1, this.mentionResults.length - 1);
        this.updateMentionDropdown();
        return;
      }
      if (evt.key === "ArrowUp") {
        evt.preventDefault();
        this.mentionIndex = Math.max(this.mentionIndex - 1, 0);
        this.updateMentionDropdown();
        return;
      }
      if (evt.key === "Enter" || evt.key === "Tab") {
        evt.preventDefault();
        this.selectMention(this.mentionIndex);
        return;
      }
      if (evt.key === "Escape") {
        this.closeMentionDropdown();
        return;
      }
    }

    // Send on Enter (without Shift)
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      if (this.isStreaming) return;
      this.handleSend();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Selection polling                                                 */
  /* ------------------------------------------------------------------ */

  private pollEditorSelection(): void {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf?.view) return;
    const view = leaf.view as any;

    // Markdown editor selection
    if (view.editor && typeof view.editor.getSelection === "function") {
      const sel = view.editor.getSelection();
      if (sel && sel.trim().length > 0) {
        this.preservedPdfSelection = null;
        const file = view.file;
        const filePath = file ? file.path : "unknown";
        const from = view.editor.getCursor("from");
        const to = view.editor.getCursor("to");
        const lines = from && to ? `${from.line + 1}-${to.line + 1}` : "unknown";

        if (!this.preservedSelection ||
            this.preservedSelection.text !== sel ||
            this.preservedSelection.path !== filePath ||
            this.preservedSelection.lines !== lines) {
          this.preservedSelection = {
            text: sel,
            path: filePath,
            lines: lines,
          };
          this.renderChips();
        }
        return;
      }
    }

    // PDF viewer DOM selection
    if (view.file && view.file.extension === "pdf") {
      const domSel = window.getSelection();
      if (!domSel) return;
      const selText = domSel.toString().trim();
      if (selText.length > 0) {
        const leafContainer = view.containerEl || view.contentEl;
        if (!isSelectionInsideContainer(leafContainer, domSel.anchorNode, domSel.focusNode)) return;
        this.preservedSelection = null;

        if (!this.preservedPdfSelection ||
            this.preservedPdfSelection.text !== selText ||
            this.preservedPdfSelection.path !== view.file.path) {
          this.preservedPdfSelection = {
            text: selText,
            path: view.file.path,
            page: "unknown",
          };
          this.renderChips();
        }
        return;
      }
    }
  }

  private deferChatQuoteSelection(delayMs = 0): void {
    if (this.quoteSelectionTimer) {
      window.clearTimeout(this.quoteSelectionTimer);
      this.quoteSelectionTimer = null;
    }
    this.quoteSelectionTimer = window.setTimeout(() => {
      this.quoteSelectionTimer = null;
      this.updateChatQuoteSelection();
    }, delayMs);
  }

  private updateChatQuoteSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.hideQuotePopover();
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText) {
      this.hideQuotePopover();
      return;
    }

    const range = selection.getRangeAt(0);

    if (!isSelectionInsideContainer(this.chatEl, range.startContainer, range.endContainer)) {
      this.hideQuotePopover();
      return;
    }

    const content = this.selectedMessageContent(range);
    if (!content) {
      this.hideQuotePopover();
      return;
    }

    const messageWrapper = content.closest(".cx-message-user, .cx-message-assistant") as HTMLElement | null;
    if (!messageWrapper) {
      this.hideQuotePopover();
      return;
    }

    const rect = this.selectionViewportRect(range);
    if (!rect) {
      this.hideQuotePopover();
      return;
    }

    const role = messageWrapper.dataset.messageRole === "user" ? "user" : "assistant";
    const timestamp = messageWrapper.dataset.messageTimestamp || String(Date.now());
    const roleLabel = role === "user" ? "You" : "Codex";
    const wordCount = this.quoteWordCount(selectedText);

    this.pendingQuote = {
      type: "message-quote",
      label: `Quote from ${roleLabel} · ${wordCount} words`,
      data: selectedText,
      sourcePath: `chat://current-session/${role}/${timestamp}`,
    };

    this.showQuotePopover(rect);
  }

  private selectedMessageContent(range: Range): HTMLElement | null {
    const intersectedContents = Array.from(
      this.chatEl.querySelectorAll<HTMLElement>(".cx-message-content"),
    ).filter((content) => {
      try {
        return range.intersectsNode(content);
      } catch {
        return false;
      }
    });

    if (intersectedContents.length === 1) return intersectedContents[0];
    if (intersectedContents.length > 1) return null;

    const directContents = [
      this.closestMessageContent(range.startContainer),
      this.closestMessageContent(range.endContainer),
      this.closestMessageContent(range.commonAncestorContainer),
    ].filter((el): el is HTMLElement => !!el);

    const uniqueDirectContents = Array.from(new Set(directContents));
    return uniqueDirectContents.length === 1 ? uniqueDirectContents[0] : null;
  }

  private closestMessageContent(node: Node | null): HTMLElement | null {
    if (!node) return null;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) return null;
    const content = el.closest(".cx-message-content") as HTMLElement | null;
    if (!content || !this.chatEl.contains(content)) return null;
    return content;
  }

  private selectionViewportRect(range: Range): DOMRect | null {
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return rect;

    const firstRect = Array.from(range.getClientRects()).find((r) => r.width > 0 || r.height > 0);
    return firstRect || null;
  }

  private showQuotePopover(selectionRect: DOMRect): void {
    if (!this.quotePopoverEl) return;
    this.quotePopoverEl.style.display = "inline-flex";

    const popoverRect = this.quotePopoverEl.getBoundingClientRect();
    const popoverWidth = popoverRect.width || 72;
    const popoverHeight = popoverRect.height || 32;
    const margin = 10;

    const preferredLeft = selectionRect.left + selectionRect.width / 2 - popoverWidth / 2;
    const left = Math.min(
      window.innerWidth - popoverWidth - margin,
      Math.max(margin, preferredLeft),
    );

    let top = selectionRect.top - popoverHeight - 8;
    if (top < margin) {
      top = Math.min(window.innerHeight - popoverHeight - margin, selectionRect.bottom + 8);
    }

    this.quotePopoverEl.style.left = `${left}px`;
    this.quotePopoverEl.style.top = `${Math.max(margin, top)}px`;
  }

  private hideQuotePopover(): void {
    this.pendingQuote = null;
    if (this.quotePopoverEl) {
      this.quotePopoverEl.style.display = "none";
    }
  }

  private acceptPendingQuote(): void {
    if (!this.pendingQuote) return;
    this.addChip(this.pendingQuote);
    this.hideQuotePopover();
    window.getSelection()?.removeAllRanges();
    this.inputEl.focus();
  }

  private quoteWordCount(text: string): number {
    const expandedCjk = text.replace(/[\u3400-\u9fff]/g, " $& ");
    return expandedCjk.trim().split(/\s+/).filter(Boolean).length;
  }

  private quoteRoleLabelFromSource(sourcePath: string): string {
    return sourcePath.includes("/user/") ? "You" : "Codex";
  }

  /* ------------------------------------------------------------------ */
  /*  Chip management                                                   */
  /* ------------------------------------------------------------------ */

  private addChip(chip: ContextChip): void {
    this.chips.push(chip);
    this.renderChips();
  }

  private removeChip(chip: ContextChip): void {
    if (chip.type === "selection") {
      this.preservedSelection = null;
    } else if (chip.type === "pdf-selection") {
      this.preservedPdfSelection = null;
    } else {
      const idx = this.chips.indexOf(chip);
      if (idx >= 0) this.chips.splice(idx, 1);
    }
    this.renderChips();
  }

  private renderChips(): void {
    this.chipsEl.empty();
    
    const allChips: ContextChip[] = [];
    if (this.preservedSelection) {
      const lineCount = this.preservedSelection.text.split("\n").length;
      allChips.push({
        type: "selection",
        label: `${lineCount} lines · ${this.preservedSelection.path}`,
        data: this.preservedSelection.text,
        sourcePath: this.preservedSelection.path,
        lines: this.preservedSelection.lines,
      });
    }
    if (this.preservedPdfSelection) {
      const ps = this.preservedPdfSelection;
      const wordCount = ps.text.split(/\s+/).length;
      allChips.push({
        type: "pdf-selection",
        label: `PDF ${wordCount} words · ${ps.path}`,
        data: ps.text,
        sourcePath: ps.path,
        lines: ps.page,
      });
    }
    allChips.push(...this.chips);

    if (allChips.length === 0) {
      this.chipsEl.style.display = "none";
      return;
    }
    this.chipsEl.style.display = "flex";

    for (let i = 0; i < allChips.length; i++) {
      const chip = allChips[i];
      const el = this.chipsEl.createDiv({ cls: "cx-chip" });

      if (chip.type === "image") {
        if (chip.thumbnail) {
          const thumb = el.createEl("img", { cls: "cx-chip-thumbnail" });
          thumb.src = chip.thumbnail;
        }
        el.createEl("span", { cls: "cx-chip-badge", text: "IMG" });
      } else if (chip.type === "file") {
        const ext = chip.sourcePath.split(".").pop() || "";
        el.createEl("span", { cls: "cx-chip-badge", text: fileTypeBadge(ext) });
      } else if (chip.type === "selection") {
        el.createEl("span", { cls: "cx-chip-badge", text: "SEL" });
      } else if (chip.type === "pdf-selection") {
        el.createEl("span", { cls: "cx-chip-badge", text: "PDF" });
      } else if (chip.type === "message-quote") {
        el.createEl("span", { cls: "cx-chip-badge", text: "QUOTE" });
      }

      el.createEl("span", { text: chip.label || chip.sourcePath, cls: "cx-chip-label" });

      const removeBtn = el.createEl("button", { cls: "cx-chip-remove" });
      removeBtn.addEventListener("click", () => this.removeChip(chip));
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Paste & drop                                                      */
  /* ------------------------------------------------------------------ */

  private async handlePaste(evt: ClipboardEvent): Promise<void> {
    const items = evt.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        evt.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await this.saveImageBlobAsAttachment(file);
        }
      }
    }
  }

  private async handleDrop(evt: DragEvent): Promise<void> {
    const files = evt.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith("image/")) {
        evt.preventDefault();
        await this.saveImageBlobAsAttachment(file);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Send / Cancel                                                     */
  /* ------------------------------------------------------------------ */

  private async handleSend(): Promise<void> {
    if (this.isStreaming) return;
    this.hideQuotePopover();
    const rawText = this.inputEl.value.trim();
    const hasImages = this.chips.some(c => c.type === "image");
    if (!rawText && !hasImages) return;

    const { prompt: promptToSend, displayContent } = getImageOnlyPromptAndDisplay(hasImages, rawText);

    // Build context chips from selection
    const allChips: ContextChip[] = [];
    if (this.preservedSelection) {
      const lineCount = this.preservedSelection.text.split("\n").length;
      allChips.push({
        type: "selection",
        label: `${lineCount} lines · ${this.preservedSelection.path}`,
        data: this.preservedSelection.text,
        sourcePath: this.preservedSelection.path,
        lines: this.preservedSelection.lines,
      });
    }
    if (this.preservedPdfSelection) {
      const ps = this.preservedPdfSelection;
      const wordCount = ps.text.split(/\s+/).length;
      allChips.push({
        type: "pdf-selection",
        label: `PDF ${wordCount} words · ${ps.path}`,
        data: ps.text,
        sourcePath: ps.path,
        lines: ps.page,
      });
    }
    allChips.push(...this.chips);

    // Auto-detect @paths in text
    const mentionedPaths = extractMentionedPaths(rawText);
    for (const p of mentionedPaths) {
      const alreadyChip = allChips.some((c) => c.sourcePath === p);
      if (alreadyChip) continue;

      if (isImageFilePath(p)) {
        const ext = p.split(".").pop() || "";
        const absPath = this.resolveImagePath(p);
        let sizeBytes = 0;
        try {
          const fs = require("fs");
          if (fs.existsSync(absPath)) {
            sizeBytes = fs.statSync(absPath).size;
          }
        } catch {}
        allChips.push({
          type: "image",
          label: p.split("/").pop() || p,
          data: "",
          sourcePath: absPath,
          mime: `image/${ext}`,
          sizeBytes: sizeBytes,
        });
      } else {
        try {
          const file = this.app.vault.getAbstractFileByPath(p);
          if (file instanceof TFile) {
            const content = await this.app.vault.read(file);
            allChips.push({
              type: "file",
              label: file.name,
              data: content.slice(0, this.plugin.settings.maxFileContextChars),
              sourcePath: p,
            });
          }
        } catch {
          // skip unreadable files
        }
      }
    }

    // Load file content for file chips that don't have data yet
    for (const chip of allChips) {
      if ((chip.type === "file" || chip.type === "image") && !chip.data) {
        try {
          const file = this.app.vault.getAbstractFileByPath(chip.sourcePath);
          if (file instanceof TFile && !isImageFilePath(chip.sourcePath)) {
            const content = await this.app.vault.read(file);
            chip.data = content.slice(0, this.plugin.settings.maxFileContextChars);
          }
        } catch {
          // use empty data
        }
      }
    }

    // Build the prompt
    const contextXml = buildContextPrompt(allChips, this.plugin.settings.maxFileContextChars, this.plugin.settings.maxTotalContextChars);
    const fullPrompt = contextXml ? `${contextXml}\n\n${promptToSend}` : promptToSend;

    // Add user message to UI
    const userMsg: ChatMessage = {
      role: "user",
      content: fullPrompt,
      displayContent: displayContent,
      timestamp: Date.now(),
      sendStatus: "pending",
      contextAttachments: cloneMessage(allChips),
    };
    this.messages.push(userMsg);
    this.appendMessageEl(userMsg, this.messages.length - 1);

    // Clear input and chips
    this.inputEl.value = "";
    this.autoResizeInput();
    this.chips = [];
    this.preservedSelection = null;
    this.preservedPdfSelection = null;
    this.renderChips();

    // Add placeholder assistant message
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      displayContent: "",
      timestamp: Date.now(),
      sendStatus: "pending",
      contextAttachments: [],
    };
    this.messages.push(assistantMsg);
    const assistantIdx = this.messages.length - 1;
    const assistantWrapper = this.appendMessageEl(assistantMsg, assistantIdx);
    const assistantContent = this.getMessageContentEl(assistantWrapper);
    this.scrollToBottom();

    // Prepare image paths for -i flag
    const imagePaths = allChips
      .filter((c) => c.type === "image" && c.sourcePath)
      .map((c) => this.resolveImagePath(c.sourcePath));

    // Start streaming
    this.isStreaming = true;
    this.setStreamingUI(true);
    this.showStatus("Thinking…");
    this.inputEl.focus();
    this.scrollToBottom();

    // Resolve vault root
    const vaultRoot = (this.app.vault.adapter as any).basePath || "";

    const bridgeSettings: CodexBridgeSettings = {
      codexCliPath: this.plugin.settings.codexCliPath,
      modelPresets: this.plugin.settings.modelPresets,
      selectedModel: this.plugin.settings.selectedModel,
      reasoningEffort: this.effortSelect.value,
      webSearchMode: this.plugin.settings.webSearchMode,
      sandboxMode: this.plugin.settings.sandboxMode,
      approvalPolicy: this.plugin.settings.approvalPolicy,
      requestTimeoutMinutes: this.plugin.settings.requestTimeoutMinutes,
    };

    let accumulatedText = "";
    let version = ++this.messageVersion;

    try {
      const stream = sendPrompt(bridgeSettings, {
        prompt: fullPrompt,
        sessionId: this.sessionId || undefined,
        imagePaths,
      }, vaultRoot);

      for await (const evt of stream) {
        if (this.messageVersion !== version) break; // new chat started

        switch (evt.type) {
          case "thread_started":
            if (evt.threadId) {
              this.sessionId = evt.threadId;
            }
            break;

          case "text":
            accumulatedText += evt.content;
            assistantMsg.content = accumulatedText;
            assistantMsg.displayContent = accumulatedText;
            this.renderAssistantMessage(assistantContent, accumulatedText, version);
            this.scrollToBottom();
            break;

          case "turn_completed":
            if (evt.usage) {
              assistantMsg.usage = {
                input_tokens: evt.usage.input_tokens,
                output_tokens: evt.usage.output_tokens,
              };
            }
            this.showStatus("");
            break;

          case "error":
            accumulatedText += `\n\n> ⚠️ ${evt.content}`;
            assistantMsg.content = accumulatedText;
            assistantMsg.displayContent = accumulatedText;
            this.renderAssistantMessage(assistantContent, accumulatedText, version);
            break;

          case "cancelled":
            assistantMsg.sendStatus = "cancelled";
            if (accumulatedText) {
              assistantMsg.displayContent = appendPartialWarning(accumulatedText);
              this.renderAssistantMessage(assistantContent, assistantMsg.displayContent, version);
            }
            break;

          case "status":
            this.showStatus(evt.content);
            break;

          case "done":
            break;
        }
      }

      // Classify final status
      if (assistantMsg.sendStatus === "cancelled") {
        // already handled
      } else if (accumulatedText) {
        assistantMsg.sendStatus = "success";
      } else {
        assistantMsg.sendStatus = "no-result";
      }
      userMsg.sendStatus = "success";
    } catch (err) {
      assistantMsg.sendStatus = "process-error";
      const errMsg = err instanceof Error ? err.message : String(err);
      accumulatedText += `\n\n> ⚠️ Error: ${errMsg}`;
      assistantMsg.content = accumulatedText;
      assistantMsg.displayContent = accumulatedText;
      this.renderAssistantMessage(assistantContent, accumulatedText, version);
    } finally {
      this.isStreaming = false;
      this.setStreamingUI(false);
      this.showStatus("");
      this.saveCurrentConversation();
      this.plugin.historyStore.flushNow();
    }
  }

  private handleCancel(): void {
    killCodexProcess();
    this.showStatus("Cancelling…");
  }

  /* ------------------------------------------------------------------ */
  /*  New Chat                                                          */
  /* ------------------------------------------------------------------ */

  private handleNewChat(): void {
    if (this.isStreaming) {
      killCodexProcess();
    }
    this.messageVersion++;
    this.messages = [];
    this.chips = [];
    this.sessionId = null;
    this.preservedSelection = null;
    this.preservedPdfSelection = null;
    this.hideQuotePopover();
    this.chatEl.empty();
    this.welcomeEl = this.chatEl.createDiv({ cls: "cx-welcome" });
    this.welcomeEl.createEl("p", { text: "Welcome to Codex Renderer" });
    this.welcomeEl.createEl("p", {
      text: "This plugin uses the official Codex CLI with your ChatGPT subscription. No API keys needed.",
      cls: "cx-welcome-sub",
    });
    this.renderChips();
    this.showStatus("");
    this.isStreaming = false;
    this.setStreamingUI(false);
  }

  /* ------------------------------------------------------------------ */
  /*  History                                                           */
  /* ------------------------------------------------------------------ */

  private showHistory(): void {
    const conversations = this.plugin.historyStore.getConversations();
    const modal = new HistoryModal(
      this.app,
      conversations,
      (conv) => this.restoreConversation(conv),
      (conv) => this.deleteConversation(conv),
    );
    modal.open();
  }

  private restoreConversation(conv: Conversation): void {
    if (this.isStreaming) killCodexProcess();
    this.messageVersion++;
    this.messages = cloneMessage(conv.messages);
    this.sessionId = conv.sessionId;
    this.chips = [];
    this.preservedSelection = null;
    this.preservedPdfSelection = null;
    this.hideQuotePopover();
    this.chatEl.empty();
    this.welcomeEl = this.chatEl.createDiv({ cls: "cx-welcome" });
    this.welcomeEl.style.display = "none";

    for (let i = 0; i < this.messages.length; i++) {
      this.appendMessageEl(this.messages[i], i);
    }
    this.renderChips();
    this.scrollToBottom();

    // Restore model selection
    const catalog = this.plugin.settings.modelCatalog || [];
    const allPresets = catalog.map((m: any) => m.slug).concat(this.plugin.settings.modelPresets);
    if (conv.lastModel && allPresets.includes(conv.lastModel)) {
      this.modelSelect.value = conv.lastModel;
      this.plugin.settings.selectedModel = conv.lastModel;
      this.plugin.saveSettings();
    }
    this.updateEffortDropdownOptions();
    if (conv.lastEffort) {
      this.effortSelect.value = conv.lastEffort;
      this.plugin.settings.reasoningEffort = conv.lastEffort;
      this.plugin.saveSettings();
    }
    this.renderModelMenu();
    this.renderEffortMenu();
    this.updateOptionButtonLabels();
  }

  private deleteConversation(conv: Conversation): void {
    const all = this.plugin.historyStore.getConversations();
    const filtered = all.filter((c) => c.sessionId !== conv.sessionId);
    this.plugin.historyStore.save(filtered);
    if (this.sessionId === conv.sessionId) {
      this.handleNewChat();
    }
  }

  private saveCurrentConversation(): void {
    if (this.messages.length === 0) return;
    if (!this.sessionId) return;

    const all = this.plugin.historyStore.getConversations();
    const existing = all.findIndex((c) => c.sessionId === this.sessionId);

    const conv: Conversation = {
      sessionId: this.sessionId,
      title: generateTitle(this.messages[0]?.displayContent || ""),
      createdAt: this.messages[0]?.timestamp || Date.now(),
      updatedAt: Date.now(),
      lastModel: this.modelSelect.value,
      lastEffort: this.effortSelect.value,
      messages: cloneMessage(this.messages),
    };

    if (existing >= 0) {
      all[existing] = conv;
    } else {
      all.unshift(conv);
    }

    // Trim to max
    while (all.length > MAX_CONVERSATIONS) all.pop();

    this.plugin.historyStore.save(all);
  }

  /* ------------------------------------------------------------------ */
  /*  DOM helpers                                                       */
  /* ------------------------------------------------------------------ */

  private appendMessageEl(msg: ChatMessage, _index: number): HTMLDivElement {
    if (this.welcomeEl) this.welcomeEl.style.display = "none";

    const wrapper = this.chatEl.createDiv({
      cls: msg.role === "user" ? "cx-message-user" : "cx-message-assistant",
    });
    wrapper.dataset.messageRole = msg.role;
    wrapper.dataset.messageTimestamp = String(msg.timestamp || Date.now());

    if (msg.role === "user") {
      if (msg.contextAttachments && msg.contextAttachments.length > 0) {
        this.renderContextCards(wrapper, msg.contextAttachments);
      }
      const content = wrapper.createDiv({ cls: "cx-message-content" });
      content.setText(msg.displayContent);
    } else {
      const content = wrapper.createDiv({ cls: "cx-message-content" });
      if (msg.displayContent) {
        this.renderAssistantMessage(content, msg.displayContent, this.messageVersion);
      }
    }

    return wrapper;
  }

  private getMessageContentEl(wrapper: HTMLDivElement): HTMLDivElement {
    const existing = Array.from(wrapper.children).find((child): child is HTMLDivElement => {
      return child instanceof HTMLDivElement && child.classList.contains("cx-message-content");
    });
    if (existing) return existing;
    return wrapper.createDiv({ cls: "cx-message-content" });
  }

  private renderAssistantMessage(el: HTMLDivElement, md: string, version: number): void {
    const sourcePath = this.app.workspace.getActiveFile()?.path || "";
    enqueueRender(md, el, sourcePath, this.app, version);
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    });
  }

  private showStatus(text: string): void {
    if (text) {
      this.statusEl.setText(text);
      this.statusEl.style.display = "inline-flex";
    } else {
      this.statusEl.style.display = "none";
    }
  }

  private setStreamingUI(streaming: boolean): void {
    this.sendBtn.style.display = streaming ? "none" : "";
    this.cancelBtn.style.display = streaming ? "" : "none";
    this.inputEl.disabled = false;
    this.newChatBtn.disabled = streaming;
    this.modelMenuBtn.disabled = streaming;
    this.effortMenuBtn.disabled = streaming;
    if (streaming) this.closeOptionMenus();
  }

  private toggleOptionMenu(kind: "model" | "effort"): void {
    const menu = kind === "model" ? this.modelMenuEl : this.effortMenuEl;
    const btn = kind === "model" ? this.modelMenuBtn : this.effortMenuBtn;
    const shouldOpen = menu.style.display === "none";
    this.closeOptionMenus();
    if (!shouldOpen) return;

    if (kind === "model") {
      this.renderModelMenu();
    } else {
      this.renderEffortMenu();
    }
    menu.style.display = "block";
    btn.addClass("is-open");
  }

  private closeOptionMenus(): void {
    if (this.modelMenuEl) this.modelMenuEl.style.display = "none";
    if (this.effortMenuEl) this.effortMenuEl.style.display = "none";
    this.modelMenuBtn?.removeClass("is-open");
    this.effortMenuBtn?.removeClass("is-open");
  }

  private renderModelMenu(): void {
    this.modelMenuEl.empty();
    const options = Array.from(this.modelSelect.options);
    for (const option of options) {
      const row = this.modelMenuEl.createEl("button", {
        cls: `cx-option-menu-item${option.value === this.modelSelect.value ? " is-selected" : ""}`,
      });
      row.createSpan({ cls: "cx-option-menu-label", text: option.text });
      if (option.value === this.modelSelect.value) {
        row.createSpan({ cls: "cx-option-menu-check", text: "Selected" });
      }
      row.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.modelSelect.value = option.value;
        this.modelSelect.dispatchEvent(new Event("change"));
      });
    }
  }

  private renderEffortMenu(): void {
    this.effortMenuEl.empty();
    const options = Array.from(this.effortSelect.options);
    for (const option of options) {
      const row = this.effortMenuEl.createEl("button", {
        cls: `cx-option-menu-item${option.value === this.effortSelect.value ? " is-selected" : ""}`,
      });
      row.createSpan({ cls: "cx-option-menu-label", text: option.text.replace(/^Effort: /, "") });
      if (option.value === this.effortSelect.value) {
        row.createSpan({ cls: "cx-option-menu-check", text: "Selected" });
      }
      row.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.effortSelect.value = option.value;
        this.effortSelect.dispatchEvent(new Event("change"));
      });
    }
  }

  private updateOptionButtonLabels(): void {
    const modelLabel = this.modelSelect.selectedOptions[0]?.text || "Default";
    const effortLabel = this.effortSelect.selectedOptions[0]?.text || "Effort: Default";
    this.modelMenuBtn.title = `Model: ${modelLabel}`;
    this.modelMenuBtn.setAttribute("aria-label", `Model: ${modelLabel}`);
    this.effortMenuBtn.title = effortLabel;
    this.effortMenuBtn.setAttribute("aria-label", effortLabel);
  }

  updateModelDropdownOptions(): void {
    if (!this.modelSelect) return;
    const currentVal = this.modelSelect.value || this.plugin.settings.selectedModel;
    this.modelSelect.empty();
    this.modelSelect.createEl("option", { value: "", text: "Model: Default" });
    const catalog = this.plugin.settings.modelCatalog || [];
    if (catalog.length > 0) {
      for (const m of catalog) {
        this.modelSelect.createEl("option", { value: m.slug, text: m.displayName });
      }
    } else {
      for (const m of this.plugin.settings.modelPresets) {
        this.modelSelect.createEl("option", { value: m, text: m });
      }
    }
    const allPresets = catalog.map(m => m.slug).concat(this.plugin.settings.modelPresets);
    if (currentVal && allPresets.includes(currentVal)) {
      this.modelSelect.value = currentVal;
    } else {
      this.modelSelect.value = "";
    }
    this.updateEffortDropdownOptions();
    this.renderModelMenu();
    this.updateOptionButtonLabels();
  }

  updateEffortDropdownOptions(): void {
    if (!this.effortSelect) return;
    const currentModel = this.modelSelect.value;
    const catalog = this.plugin.settings.modelCatalog || [];
    const effortOptions = getEffortOptionsForModel(currentModel, catalog);
    const currentVal = this.effortSelect.value || this.plugin.settings.reasoningEffort;
    this.effortSelect.empty();
    for (const e of effortOptions) {
      this.effortSelect.createEl("option", { value: e, text: `Effort: ${getEffortDisplayLabel(e)}` });
    }
    if (effortOptions.includes(currentVal)) {
      this.effortSelect.value = currentVal;
    } else {
      const model = catalog.find((entry: any) => entry.slug === currentModel);
      const fallback = model?.defaultReasoningLevel;
      this.effortSelect.value = effortOptions.includes(fallback) ? fallback : effortOptions[0] || "default";
    }
    this.renderEffortMenu();
    this.updateOptionButtonLabels();
  }

  private resolveImagePath(filePath: string): string {
    if (require("path").isAbsolute(filePath)) return filePath;
    const adapter = (this.app as any).vault?.adapter;
    const base = adapter?.basePath || process.cwd();
    return require("path").join(base, filePath);
  }

  private imageSrcForApp(absPath: string): string {
    try {
      const path = require("path");
      const adapter = (this.app as any).vault?.adapter;
      const base = adapter?.basePath;
      if (base && typeof adapter?.getResourcePath === "function") {
        const rel = path.relative(base, absPath);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
          return adapter.getResourcePath(rel);
        }
      }
    } catch {}
    return imageSrcForPath(absPath);
  }

  private vaultRelativePathForAbs(absPath: string): string | null {
    try {
      const path = require("path");
      const adapter = (this.app as any).vault?.adapter;
      const base = adapter?.basePath;
      if (!base) return null;
      const rel = path.relative(base, absPath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel;
      }
    } catch {}
    return null;
  }

  private getAttachmentsDir(): string {
    const adapter = (this.app as any).vault?.adapter;
    const base = adapter?.basePath || process.cwd();
    return require("path").join(base, ".obsidian", "plugins", "codex-renderer", "attachments");
  }

  private generateThumbnail(absPath: string, mime: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const maxDim = 48;
          const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(undefined);
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL(mime));
        } catch {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = this.imageSrcForApp(absPath);
    });
  }

  async saveImageBlobAsAttachment(file: File): Promise<void> {
    const attachDir = this.getAttachmentsDir();
    const fs = require("fs");
    const path = require("path");
    if (!fs.existsSync(attachDir)) {
      fs.mkdirSync(attachDir, { recursive: true });
    }
    const ext = this.mimeToExtension(file.type);
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
    const filePath = path.join(attachDir, filename);
    const arrayBuf = await file.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuf));

    const thumbnail = await this.generateThumbnail(filePath, file.type);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(filePath).size;
    } catch {}

    this.addChip({
      type: "image",
      label: file.name,
      data: "",
      sourcePath: filePath,
      mime: file.type,
      sizeBytes: sizeBytes,
      thumbnail: thumbnail,
    });
  }

  private mimeToExtension(mime: string): string {
    switch (mime) {
      case "image/png": return ".png";
      case "image/jpeg": return ".jpg";
      case "image/webp": return ".webp";
      default: return ".png";
    }
  }

  private renderContextCards(bubble: HTMLDivElement, attachments: ContextChip[]): void {
    for (const att of attachments) {
      if (att.type === "image") {
        const card = bubble.createDiv({ cls: "cx-context-card cx-context-image-card" });
        const summary = card.createDiv({ cls: "cx-context-summary" });
        const sizeStr = att.sizeBytes ? ` · ${Math.round(att.sizeBytes / 1024)} KB` : "";
        const filename = att.label || att.sourcePath.split("/").pop() || "";
        summary.createSpan({ text: `🖼 IMG ${filename}${sizeStr}` });

        try {
          const fs = require("fs");
          const absPath = this.resolveImagePath(att.sourcePath);
          if (fs.existsSync(absPath)) {
            const img = card.createEl("img", { cls: "cx-context-image-preview" });
            img.src = this.imageSrcForApp(absPath);
            img.addEventListener("click", (e) => {
              e.stopPropagation();
              const src = this.imageSrcForApp(absPath);
              const rel = this.vaultRelativePathForAbs(absPath);
              const displayPath = rel || absPath;
              new ImagePreviewModal(this.app, src, absPath, displayPath).open();
            });
          }
        } catch {}
        continue;
      }

      const detailsCls = att.type === "message-quote"
        ? "cx-context-card cx-context-quote-card"
        : "cx-context-card";
      const details = bubble.createEl("details", { cls: detailsCls });
      const summary = details.createEl("summary", { cls: "cx-context-summary" });

      let summaryText = "";
      if (att.type === "selection") {
        const lineCount = (att.data || "").split("\n").length;
        summaryText = `📄 SEL ${lineCount} lines · ${att.sourcePath}`;
      } else if (att.type === "pdf-selection") {
        const wordCount = (att.data || "").trim().split(/\s+/).filter(Boolean).length;
        summaryText = `📑 PDF ${wordCount} words · ${att.sourcePath}`;
      } else if (att.type === "message-quote") {
        const wordCount = this.quoteWordCount(att.data || "");
        summaryText = `💬 QUOTE ${wordCount} words · ${this.quoteRoleLabelFromSource(att.sourcePath)}`;
      } else {
        const charCount = (att.data || "").length;
        summaryText = `📑 FILE ${charCount} chars · ${att.sourcePath}`;
      }

      summary.createSpan({ text: summaryText });
      const body = details.createDiv({ cls: "cx-context-body" });
      body.setText(att.data || "");
    }
  }
}
