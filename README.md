# Codex Renderer Obsidian Plugin

A thin Obsidian renderer UI for the official local [Codex CLI](https://github.com/google-deepmind/codex).

## Design Philosophy

- **Official local CLI integration**: Relies entirely on the official local Codex CLI tool which handles session state, execution sandboxing, and ChatGPT subscription-based authentication.
- **Zero API keys**: The plugin requires no direct OpenAI/Anthropic API keys and does not provide setting options for adding keys.
- **Single Source of Truth**: Codex session files are the official history source of truth. Official Codex CLI rollout files are under `~/.codex/sessions/`. The local `history.json` cache managed by the plugin is for Obsidian UI convenience only.
- **Codex App History vs CLI**: Codex app sidebar/history may not show non-interactive `codex exec` runs.
- **No Secondary Trace source**: Conversations executed via this plugin are registered under official Codex session files and can be processed by standard Vault scripts (e.g., `scripts/copilot.py writeback-ai-day`).

## Settings & CLI Argument Binding

- **Model selection**: Configurable via a dropdown menu. If set, passes `-m <model>` to `codex exec`. The "Default" option passes no model parameter (letting local Codex configuration choose).
- **Dynamic model catalog**: Models, display names, ordering, defaults, and supported reasoning levels are refreshed from the installed CLI via `codex debug models`. The bundled list is only an explicitly labelled offline fallback.
- **Reasoning effort override**: Adjusts the reasoning depth of the selected model. Passed as a verified Codex configuration override using `-c model_reasoning_effort="<value>"`. The composer mirrors ChatGPT Codex's default product controls and labels: `Light`, `Medium`, `High`, `Extra High`, and `Ultra` when supported by the selected model. The CLI-only `max` level is not shown because the ChatGPT Codex UI excludes it by default.
- **Web search**: Toggleable in settings. If enabled, passes `--search` to the execution command.
- **Sandbox mode**: Defaults to `workspace-write` (passes `--sandbox workspace-write` to `codex exec`).
- **Approval policy**: `codex exec` does not accept the top-level `--ask-for-approval` flag, so the renderer does not pass approval-policy arguments. It also never uses dangerous overrides like `--dangerously-bypass-approvals-and-sandbox`.
- **Renderer environment parity**: When Obsidian is launched from the macOS GUI, its environment may omit the merged ChatGPT app, legacy Codex.app, Codex primary runtime, and Homebrew paths. The renderer searches and prepends both `/Applications/ChatGPT.app/Contents/Resources` and the legacy Codex.app location before spawning the CLI, while retaining the other common tool paths. Desktop-only app tools such as Browser, Chrome, Computer Use, and image generation remain desktop capabilities, not renderer-provided CLI tools.

## Development

```bash
npm install
npm run build
npm test
```

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
