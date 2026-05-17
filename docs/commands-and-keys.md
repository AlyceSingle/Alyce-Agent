<p align="center">
  English | <a href="./zh-CN/commands-and-keys.md">简体中文</a>
</p>

# Commands and Keys

Alyce speaking. *I always feel a bit silly writing a keyboard shortcuts page, but honestly — this is the kind of thing you need at 2 AM when you can't remember how to open settings.*

Everything listed here is actually wired up in the current runtime. No theoretical keys, no "coming soon" placeholders.

## Slash Commands

Type these into the main input. They start with `/` and execute immediately.

### The Essentials

| Command | What it does |
|---|---|
| `/help` | Shows all available commands. *Start here if you're lost.* |
| `/doctor` | Runs local health checks for Node, TTY, workspace files, connection config, approval risk, MCP config, skills, provider plugins, `rg`, `git`, `.alyce` storage, snapshot storage, and request patches. |
| `/settings` | Jumps straight to the settings dialog. |
| `/permissions` | Opens the four-mode approval and access switcher. |
| `/setup` | Alias for `/connect`; opens the provider picker. |
| `/clear` | Wipes the current conversation and starts fresh. |
| `/rewind` | Opens the rewind selector so you can restore to an earlier prompt. |
| `/exit` | Closes Alyce. |

### Plan Mode

| Command | What it does |
|---|---|
| `/plan` | Enters Plan Mode. Alyce can inspect, ask questions, and draft a plan, but write tools, mutating shell commands, subagents, mutating MCP tools, and skill loading are blocked. |
| `/plan exit` | Leaves Plan Mode and restores normal build/edit permissions. |
| `/build` | Alias for leaving Plan Mode. In the current runtime this does **not** run `npm run build`; it only switches out of Plan Mode. |

Plan Mode still allows read-oriented exploration: `Read`, `Glob`, `Grep`, `LSP`, web fetch/search, MCP status/resource listing/resource reads, `TaskList`, `TaskGet`, and read-only shell or PowerShell inspection commands after approval. If a shell command looks like it might write files, install packages, mutate git state, or run arbitrary code, Alyce blocks it while Plan Mode is active.

### Diff

| Command | What it does |
|---|---|
| `/diff` | Shows a combined overview: the latest Alyce turn summary plus the current git working tree summary. |
| `/diff last` | Shows the latest Alyce turn diff from Alyce's file-history snapshots. This does not require git. |
| `/diff current` | Shows the current git working tree diff. If git is unavailable, Alyce reports that clearly. |
| `/diff <turn>` | Shows a specific Alyce turn diff by turn ID. |

After a turn edits files, Alyce also prints a concise diff summary with file counts, added/modified/deleted counts, line stats, and a pointer to `/diff last` for the full patch.

### Revert

| Command | What it does |
|---|---|
| `/revert` | Opens a confirmation prompt for the latest Alyce turn with tracked file changes. You can restore files only, restore files and rewind conversation, rewind conversation only, or cancel. |
| `/revert --files-only` | Restores tracked files from the latest Alyce turn and leaves the conversation unchanged. |
| `/revert --conversation-only` | Rewinds the conversation to the latest Alyce turn's rewind point and leaves files unchanged. |

### Memory

| Command | What it does |
|---|---|
| `/remember <text>` | Saves something to persistent memory — it survives across sessions. |
| `/remember --session <text>` | Saves to session memory — only lives as long as this session. |
| `/memory` | Shows all current memory entries. |
| `/memory clear` | Clears session memory only. |
| `/memory clear --all` | Clears *everything* — session and persistent. *Be careful with this one.* |

*The difference between persistent and session memory is simple: if you want it to stick around after you restart Alyce, use `/remember` without `--session`. If it's just for this conversation, add `--session`.*

### Context & Model

| Command | What it does |
|---|---|
| `/context` | Previews the exact payload the model will receive next turn. *This is incredibly useful for debugging — it shows you things like memory injections and compaction summaries that aren't visible in the chat.* |
| `/context <text>` | Same as above, but with an additional message added to the context. |
| `/connect` | Open the interactive provider picker, then enter API key, baseURL, and model fields in a step-by-step form. Secret fields are masked. Built-in presets include OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Kimi, Qwen, SiliconFlow, Doubao, Ollama, and LM Studio. |
| `/logout <provider>` | Remove a provider credential from `~/.alyce/auth.json` without deleting provider profiles. |
| `/model` | Refreshes the current provider's model list and opens its model picker. |
| `/models` or `/model list` | Shows the current provider/model, configured providers, known models, and switch examples. |
| `/model <name>` | Switches the active model on the current provider, e.g. `/model gpt-5.2`. |
| `/model <provider>/<model>` | Switches to a provider-qualified model, e.g. `/model openrouter/openai/gpt-5.2`. |

Advanced/scriptable forms are still available: `/connect <provider> <api-key> [model] [baseURL]` for API-key presets, `/connect <local-provider> [baseURL] [model]` for local presets, and `/connect custom <provider-id> <baseURL> <model> <api-key> [label]`.

### Usage

| Command | What it does |
|---|---|
| `/usage` | Shows current-session model usage: total tokens, provider/model groups, recent turns, subagent usage, durations, retries, and estimated cost when provider/model price metadata exists. |

When pricing is unknown, Alyce shows tokens only and does not invent a cost.

### Directory Scope

| Command | What it does |
|---|---|
| `/add-dir <path>` | Adds a directory to the agent's allowed file scope for this session. |
| `/add-dir --save <path>` | Same, but persists the directory across sessions. |

*By default, Alyce starts with the workspace as its file scope. `Read`, `Glob`, and `Grep` can request external directory access on demand; approving "Allow directory for session" adds that directory until restart. Use `/add-dir` when you want to pre-authorize a directory, and `/add-dir --save` when it should persist across sessions.*

### Session History

| Command | What it does |
|---|---|
| `/resume` | Opens the saved-sessions picker so you can jump back into a previous conversation. |
| `/resume <id or search>` | Resumes a specific session by its ID or a search match. |
| `/sessions` | Lists recently saved project sessions. |

*I use `/resume` constantly. It means I can close the terminal at the end of a day and pick up exactly where I left off the next morning.*

### Subagent Storage

Alyce's model-facing `AgentTool` includes built-in `general`, `explore`, `review`, and `verify` subagents. `verify` is read-only, can run approved build/test/lint/typecheck commands, and reports a final `pass`, `fail`, or `inconclusive` verdict. It is not a top-level `/verify` mode.

| Command | What it does |
|---|---|
| `/tasks` | Lists current-session background subagent tasks with status, agent type, and short descriptions. |
| `/tasks get <id>` | Shows bounded task details: status, paths, recent progress, result preview, error, and diff metadata when available. |
| `/tasks log <id>` | Alias for `/tasks get <id>`. |
| `/tasks stop <id>` | Requests stop for a running background task. |
| `/tasks cleanup` | Scans stale subagent storage artifacts without deleting them. |
| `/tasks cleanup --apply` | Deletes stale subagent storage artifacts found by the cleanup scan. Review the scan output before using `--apply`. |

The status bar also shows compact background task counts: running, unread completed tasks, and failed tasks. Completed background tasks post a short summary into the main conversation; use `/tasks get <id>` for details.

## Global Shortcuts

These work anywhere in the app — no matter what dialog is open.

| Key | Action |
|---|---|
| `Ctrl+Q` | Quit. *No confirmation dialog, so make sure you mean it.* |
| `Ctrl+X` | Open settings. *Probably the most-used key after typing.* |
| `Esc` | Interrupt Alyce while a request is running. From empty input, opens rewind; inside rewind, pressing it repeatedly walks to older prompts. |

## Interrupts

| Key | Action |
|---|---|
| `Ctrl+C` | Clears your current input. If a model request is running, it interrupts that request instead. |

After an interrupted turn, press `Esc` from empty input to choose where to rewind. Pick a prompt with `Enter`; if tracked file edits are available, Alyce can restore code and conversation together. If snapshots were already restored, pruned, or mixed with non-reversible side effects, the rewind picker falls back to conversation-only.

## Navigating Conversations

| Key | Action |
|---|---|
| `Up` | Move to the previous message in the conversation. |
| `Down` | Move to the next message. |

*Simple, but you'll use these a lot when reviewing what the agent did five turns ago.*

## Scrolling

| Key / Action | Effect |
|---|---|
| Mouse wheel up / down | Scroll the conversation view. |
| `PageUp` / `PageDown` | Jump a page at a time. |
| `Home` / `End` | Jump to the top or bottom of the current view. |
| `Ctrl+Home` / `Ctrl+End` | Jump to the very beginning or very end of the conversation. |
| `Ctrl+0` | Reset scroll position. |

## Settings Dialog

When you press `Ctrl+X`, a settings dialog opens. Here's how to navigate it:

### Everywhere in Settings

| Key | Action |
|---|---|
| `Up` / `Down` | Move through fields. |
| `Enter` | Edit the selected field, or toggle on/off for boolean fields, or cycle options for select fields. |
| `S` | Save all changes. |
| `Esc` | Close without saving. |

## Field Quirks

A few things that might surprise you:

- **Text fields** treat `\n` as a literal line break. If you want a newline in a prompt field, type `\n`.
- **Number fields** are automatically normalized to positive integers. Entering `-5` or `3.7` will get cleaned up.
- **Toggle fields** show `on` or `off`. Press `Enter` to flip them.

---

*That's everything that's wired up. If a key or command isn't on this page, it doesn't exist in the current build — I try not to document things that aren't actually real yet.*
