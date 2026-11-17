# Codex Renderer Obsidian Plugin

A thin Obsidian renderer UI for the official local [Codex CLI](https://github.com/google-deepmind/codex).

## Design Philosophy

- **Official local CLI integration**: Codex requests use the official local CLI for session state, execution sandboxing, and ChatGPT subscription authentication.
- **Zero API keys**: The plugin requires no direct OpenAI/Anthropic API keys and does not provide setting options for adding keys.
- **Conversation history**: Codex CLI rollout files live under `~/.codex/sessions/`. DeepSeek Harness sessions live under `~/.dsh/sessions/`. The local `history.json` cache is for Obsidian UI convenience.
- **Codex App History vs CLI**: Codex app sidebar/history may not show non-interactive `codex exec` runs.
- **Vault traces**: The standard vault importer reads Codex and DeepSeek Harness session files.

## Settings & CLI Argument Binding

- **Model selection**: Configurable via a dropdown menu. If set, passes `-m <model>` to `codex exec`. The "Default" option passes no model parameter (letting local Codex configuration choose).
- **Dynamic model catalog**: Models, display names, ordering, defaults, and supported reasoning levels are refreshed from the installed CLI via `codex debug models`. The bundled list is only an explicitly labelled offline fallback.
- **Reasoning effort override**: Adjusts the reasoning depth of the selected model. Passed as a verified Codex configuration override using `-c model_reasoning_effort="<value>"`. The composer mirrors ChatGPT Codex's default product controls and labels: `Light`, `Medium`, `High`, `Extra High`, and `Ultra` when supported by the selected model. The CLI-only `max` level is not shown because the ChatGPT Codex UI excludes it by default.
- **Web search**: Toggleable in settings. If enabled, passes `--search` to the execution command.
- **Sandbox mode**: Defaults to `workspace-write` (passes `--sandbox workspace-write` to `codex exec`).
- **Approval policy**: `codex exec` does not accept the top-level `--ask-for-approval` flag, so the renderer does not pass approval-policy arguments. It also never uses dangerous overrides like `--dangerously-bypass-approvals-and-sandbox`.
- **Renderer environment parity**: When Obsidian is launched from the macOS GUI, its environment may omit the merged ChatGPT app, legacy Codex.app, Codex primary runtime, and Homebrew paths. The renderer searches and prepends both `/Applications/ChatGPT.app/Contents/Resources` and the legacy Codex.app location before spawning the CLI, while retaining the other common tool paths. Desktop-only app tools such as Browser, Chrome, Computer Use, and image generation remain desktop capabilities, not renderer-provided CLI tools.

## DeepSeek Harness fallback

Enable **DeepSeek Harness fallback** in the plugin settings on a Mac with DeepSeek Harness installed in Applications and signed in. A new chat starts with Codex. After a detected connection failure, the plugin tries DeepSeek once if Codex has produced no reply or tool activity. DeepSeek receives the current request, including its text attachments and PNG, JPEG, WebP or GIF images, and up to 24,000 characters of recent completed chat. The Harness still connects to DeepSeek online.

Follow-ups use the DeepSeek session so it can retain context. Restart with **New Chat** to use Codex again, or open the original Codex chat in **History**. DeepSeek replies are labelled in the chat. **Rewind & edit** is available in Codex chats.

## Rewind and edit

Click **Rewind & edit** below any of your messages after Codex finishes replying. The chat returns to just before that message, and its text, images, file context, selections, and quotations return to the composer. Edit it and send again.

The renderer uses the official Codex app-server to match saved prompts to turn IDs and fork only the preceding history. The original conversation stays in **History**, and the new conversation is labelled **Rewind branch**. Rewinding the first message starts a fresh session on the next send. Existing drafts must be sent or cleared before rewinding.

This rewinds conversation context only; it keeps any file changes and other actions already performed. It never rewrites official Codex session files. If the installed CLI cannot fork at the requested boundary, or saved history differs from the displayed chat, rewind fails without changing the current chat or draft. Recent CLI versions with paginated history are supported; older versions must support `thread/fork` with `lastTurnId`.

## Development

```bash
npm install
npm run build
npm test
```

On macOS, `npm run build` also builds the AppKit Continuity Camera helper used by the composer’s **Import from iPhone…** context-menu action. The helper opens a small native window; right-click its text area and choose **Import from iPhone** to take a photo, scan a document, or add a sketch. Captured pages are added to the current message as image attachments. Other platforms build the renderer without the macOS helper.

The repository intentionally excludes local runtime state:

- `history.json` — local UI cache of conversations
- `data.json` — local plugin settings
- `attachments/` — pasted or dropped local images
- `node_modules/` and generated build artifacts

## Manual Obsidian Smoke Steps

Use the following steps to verify that the plugin works inside Obsidian:

1. **Enable the plugin**: Open Obsidian Settings -> Community Plugins. Enable the `Codex Renderer` plugin.
2. **Open Codex Chat**: Click the terminal ribbon icon to open a new blank Codex chat window. Run `Open Codex Chat` from the command palette to reveal an existing chat pane, or run `Open New Codex Chat Window` to create another blank window.
3. **Send a message**: Type a short prompt (e.g., "Hello, Codex") and hit Enter or click Send.
4. **Confirm session creation**: Verify that a new session JSONL file and index entry is written to your official history directory:
   - Check `~/.codex/session_index.jsonl` to see the new entry.
5. **Resume the chat**: Write another message in the same chat. Verify that the child process logs confirm the execution of `codex exec resume --json <sessionId> -`.
6. **AI Conversation Tracing**: Run the Vault integration script:
   ```bash
   python3 scripts/copilot.py writeback-ai-day --date YYYY-MM-DD
   ```
   Confirm that the script correctly processes the conversation from official Codex session files under `~/.codex/` and links it in your daily journal under `## 💬 From Kai` using wikilinks.
7. **iPhone image import (macOS)**: Right-click the chat input and choose **Import from iPhone…**. In the native helper window, right-click the text area and choose **Import from iPhone** -> **Take Photo**, **Scan Documents**, or **Add Sketch**. Confirm the captured image pages appear as attachment chips and are sent with the next message.
