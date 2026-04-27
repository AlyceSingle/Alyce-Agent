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
| `/settings` | Jumps straight to the settings dialog. |
| `/setup` | First-run configuration wizard. |
| `/clear` | Wipes the current conversation and starts fresh. |
| `/exit` | Closes Alyce-Agent. |

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
| `/model <name>` | Switches the active model on the fly. e.g. `/model gpt-4o` |

### Directory Scope

| Command | What it does |
|---|---|
| `/add-dir <path>` | Adds a directory to the agent's allowed file scope for this session. |
| `/add-dir --save <path>` | Same, but persists the directory across sessions. |

*By default, Alyce-Agent can only access files within the workspace. Use `/add-dir` when you need it to reach outside — say, for a shared library in another project.*

### Session History

| Command | What it does |
|---|---|
| `/resume` | Opens the saved-sessions picker so you can jump back into a previous conversation. |
| `/resume <id or search>` | Resumes a specific session by its ID or a search match. |
| `/sessions` | Lists recently saved project sessions. |

*I use `/resume` constantly. It means I can close the terminal at the end of a day and pick up exactly where I left off the next morning.*

## Global Shortcuts

These work anywhere in the app — no matter what dialog is open.

| Key | Action |
|---|---|
| `Ctrl+Q` | Quit. *No confirmation dialog, so make sure you mean it.* |
| `Ctrl+X` | Open settings. *Probably the most-used key after typing.* |
| `Ctrl+O` | Open a detailed view of the current selected message. Useful for reading long tool outputs. |
| `Esc` | Close any open dialog, leave detail view, or trigger recovery flows after an interrupted turn. |

## Interrupts

| Key | Action |
|---|---|
| `Ctrl+C` | Clears your current input. If a model request is running, it interrupts that request instead. |

If a turn gets interrupted but the state is still recoverable, the controller will offer recovery — just press `Esc` when prompted.

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
| `Left` / `Right` | Switch between the Connection and Session tabs. |
| `Up` / `Down` | Move through fields. |
| `Enter` | Edit the selected field, or toggle on/off for boolean fields, or cycle options for select fields. |
| `S` | Save all changes. |
| `Esc` | Close without saving. |

### Connection Tab Only

| Key | Action |
|---|---|
| `P` | Toggle the save target between **project** scope and **user** scope. Project config lives in `./.alyce/config.json`; user config lives in `~/.alyce/config.json`. |

*The scope toggle is easy to overlook but important. If you save a key to project scope and then share the repo... well, don't do that.*

## Field Quirks

A few things that might surprise you:

- **Text fields** treat `\n` as a literal line break. If you want a newline in a prompt field, type `\n`.
- **Number fields** are automatically normalized to positive integers. Entering `-5` or `3.7` will get cleaned up.
- **Toggle fields** show `on` or `off`. Press `Enter` to flip them.

---

*That's everything that's wired up. If a key or command isn't on this page, it doesn't exist in the current build — I try not to document things that aren't actually real yet.*
