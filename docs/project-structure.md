<p align="center">
  English | <a href="./zh-CN/project-structure.md">简体中文</a>
</p>

# Project Structure

Alyce speaking. *I've gotten lost in my own codebase more times than I'd like to admit. So I wrote this to help you avoid that.*

This file answers exactly one question: **where the code lives, what each layer does, and where to start when you want to change something.** No architectural manifestos, no UML diagrams you'll never look at again — just the map I wish I'd had.

## Top-Level Layout

```text
.
├─ src/            ← This is where you'll spend your life
├─ docs/           ← These very files you're reading
├─ dist/           ← TypeScript compiler output (don't touch)
├─ .alyce/         ← Runtime state: config, memory, session history
├─ User_Info/      ← User-owned data, not part of the repo
└─ README.md       ← The front door
```

*The `.alyce/` directory is generated at runtime. It's not source code — treat it like a database, not like something you edit by hand.*

## Inside `src/` — Layer by Layer

### Entry & Startup

```
src/index.ts
src/cli/startReactUiMode.ts
```

These two files are the on-ramp. They:
- Load environment variables from `.env`
- Validate that you're in a real interactive TTY
- Create the runtime, the UI state store, and the session controller
- Hand control over to the React UI

*If the app won't start at all, look here first. The error messages are usually pretty honest about what's missing.*

### CLI & Session Assembly

```
src/cli/sessionRuntime.ts
src/cli/commandRouter.ts
src/cli/contextPreview.ts
```

This is the middle layer that glues the model interaction to the user interface. It:
- Holds the running message chain (everything the model has seen and said)
- Merges configuration, memory, and compaction rules together
- Parses slash commands like `/help`, `/remember`, `/resume`
- Builds request previews when you use `/context`

*`sessionRuntime.ts` is probably the single most important file in this layer. It decides what the model actually receives, and that decision ripples into everything else.*

### Core Runtime

This is where the real work happens. Each subdirectory has one clear owner.

#### `src/core/agent/`

```
runAgentTurn.ts
```

The main game loop. It runs: **model call → parse tool requests → execute tools → feed results back → repeat → final answer**. Every "turn" you see in the terminal goes through this file.

#### `src/core/api/`

```
sendChatCompletion.ts
requestPatch.ts
```

Handles the actual HTTP request to the model API. Shapes the message payload, injects timestamps if enabled, and applies optional request patches. *This is where you go when the model isn't receiving what you expect.*

#### `src/core/memory/`

```
memoryService.ts
autoSummary.ts
sessionMemoryStore.ts
persistentMemoryStore.ts
```

All things memory. Collects `/remember` entries, persists them across sessions, generates auto-summaries of recent work, and decides what gets injected into the prompt. *I'm particularly fond of this layer — it's the difference between an assistant that remembers and one that forgets everything when you restart.*

#### `src/core/conversation/`

```
conversationCompactor.ts
```

The guardian against context bloat. When a conversation gets too long, this compresses older turns into a structured summary while keeping recent turns raw. *Without this, long sessions would eventually overflow the model's context window.*

#### `src/core/session-history/`

```
sessionStorage.ts
sessionResume.ts
types.ts
```

Manages project-local JSONL transcripts under `./.alyce/sessions/`. When you use `/resume`, this is what reloads an old conversation — message chain and visible terminal transcript both.

*Session history is not the same as memory. History reopens an old conversation; memory injects facts into any conversation.*

#### `src/core/prompt/`

```
builder.ts
sections.ts
sectionResolver.ts
fragments/
```

Assembles the system prompt from all its pieces — static rules, dynamic environment info, persona overlay, memory, and user customizations. If you want to change what the model "believes about itself," this is the layer.

*The fragments directory contains the static building blocks. The persona presets you've probably heard about? They live in `fragments/personaPresets.ts`.*

#### `src/core/file-history/`

```
fileHistoryManager.ts
```

Takes a snapshot before every file write and supports turn-level rollback. *I added this after one too many "oops, I shouldn't have overwritten that" moments. It's saved me more times than I can count.*

#### `src/core/time/`

```
systemTime.ts
```

A single utility that formats the current system date and time. Used by timestamp injection when `messageTimestampsEnabled` is on. *Simple, but putting it in one place means we never get inconsistent date formats.*

### Tools

```
src/tools/definitions.ts
src/tools/registry.ts
src/tools/executeToolCall.ts
```

Everything the agent can *do* — read files, search code, edit, write, run commands, browse the web, ask you questions. Each tool is a class with its own definition, execution logic, and approval behavior.

**Built-in tools:**
`AskUserQuestion` · `Read` · `Glob` · `Grep` · `TodoWrite` · `Edit` · `MultiEdit` · `apply_patch` · `Write` · `Bash` · `PowerShell` · `WebFetch` · `WebSearch`

`Read` now covers text files, directories, notebook summaries, missing-path suggestions, safer output capping for partial reads, on-demand external directory approval, and true multimodal image/PDF attachment flow for supported formats, while still surfacing asset metadata such as image dimensions. It also records file freshness state and full-read content when available so `Edit`/`MultiEdit`/`Write`/`apply_patch` can reject stale modifications while tolerating mtime-only touches. `Edit`, `MultiEdit`, `Write`, and `apply_patch` additionally block Windows UNC paths, serialize writes per file, recheck the target at byte level after approval, preserve text encoding and line endings, take raw-byte pre-write snapshots for rollback, run configured formatters when available, and return TypeScript/JavaScript diagnostics for supported files. `apply_patch` uses the opencode patch envelope for Add/Delete/Update/Move, multi-file patches, multi-hunk updates, heredoc wrappers, context anchors, EOF anchors, whitespace-tolerant matching, and Unicode punctuation matching. Binary formats that Alyce cannot inline remain metadata-only.

The `apply_patch` implementation is split between `src/tools/FileApplyPatchTool/` for the public tool and `src/tools/internal/applyPatch.ts` for parsing and hunk application. See [apply_patch Tool](apply-patch-tool.md) for the syntax and the intentional safety differences from opencode.

*If you're adding a new tool: define it, register it, then wire any new approval rules. The patterns are consistent — copy an existing tool and you'll see the shape.*

### Terminal UI

The face Alyce shows to the world. Built with React + Ink, rendered in an actual terminal.

#### `src/terminal-ui/adapters/`

```
sessionController.ts
messageMapper.ts
```

The bridge between runtime events and UI state. When the model produces output, these files translate it into something the UI can render. When you type a command, they translate it back into runtime actions.

#### `src/terminal-ui/components/`

Input widgets, dialogs, the status bar, the message viewer, the settings panel — all the visual pieces. *If a button isn't working or a dialog looks wrong, the component is almost certainly here.*

#### `src/terminal-ui/screens/`

```
AgentScreen.tsx
```

The main session screen. This is the top-level component that stitches everything together.

#### `src/terminal-ui/state/`

```
types.ts
actions.ts
store.tsx
```

UI state management — what's selected, what's open, what's loading.

#### `src/terminal-ui/keybindings/`

Keyboard shortcut definitions. `Ctrl+X`, `Ctrl+Q`, `PageUp`, `PageDown`, `Home`, `End` — they're all defined here.

#### `src/terminal-ui/runtime/ink-runtime/`

This is a vendored copy of the Ink rendering runtime. *Unless you're debugging rendering glitches, scroll behavior, or input protocol issues, you probably don't need to touch this. It's here because we need terminal rendering to be reliable, and depending on an external package wasn't going to cut it.*

## Quick Reference: Where to Change What

| You want to... | Start here |
|---|---|
| Change what the model sees | `src/core/prompt/` → `src/cli/sessionRuntime.ts` → `src/core/api/sendChatCompletion.ts` |
| Change what the user sees | `src/terminal-ui/adapters/sessionController.ts` → `src/terminal-ui/components/` → `AgentScreen.tsx` |
| Add or modify a tool | `src/tools/definitions.ts` → the tool's own directory → `src/tools/types.ts` |
| Work on memory or context | `src/core/memory/` → `conversationCompactor.ts` → `session-history/` → `sessionRuntime.ts` |
| Fix a startup crash | `src/index.ts` → `startReactUiMode.ts` |
| Tweak the system prompt | `src/core/prompt/fragments/` → `builder.ts` |

---

*That's the whole map. I hope it helps you find your way faster than I found mine.*
