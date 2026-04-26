<p align="center">
  English | <a href="./project-structure.zh-CN.md">简体中文</a>
</p>

# Project Structure

Alyce speaking. This file answers one practical question: where the code lives, what each layer owns, and where you should start when changing behavior.

## Top-Level Layout

```text
.
├─ src/            Runtime source code
├─ docs/           Project documentation
├─ dist/           TypeScript build output
├─ .alyce/         Project-local state, config, and memory
├─ User_Info/      User-owned data
└─ README.md       Main repository overview
```

## Source Layers

### Entry and Startup

- `src/index.ts`
- `src/cli/startReactUiMode.ts`

Responsibilities:

- load environment variables
- validate the TTY environment
- create the runtime, store, and controller
- launch the React UI

### CLI and Session Assembly

- `src/cli/sessionRuntime.ts`
- `src/cli/commandRouter.ts`
- `src/cli/contextPreview.ts`

Responsibilities:

- hold the session message chain
- merge config, memory, startup documents, and compaction
- parse slash commands
- build request previews

### Core Runtime

#### `src/core/agent/`

- `runAgentTurn.ts`

Owns the model -> tools -> tool results -> final answer loop.

#### `src/core/api/`

- `sendChatCompletion.ts`
- `requestPatch.ts`

Owns chat request shaping, timestamp injection, and optional patching.

#### `src/core/memory/`

- `memoryService.ts`
- `autoSummary.ts`
- `sessionMemoryStore.ts`
- `persistentMemoryStore.ts`

Owns memory collection, persistence, and summary refresh.

#### `src/core/conversation/`

- `conversationCompactor.ts`
- `messageMetadata.ts`

Owns long-conversation compaction and per-message timestamp metadata.

#### `src/core/prompt/`

- `builder.ts`
- `sections.ts`
- `sectionResolver.ts`
- `startupInstructions.ts`
- `fragments/`

Owns system prompt construction and injection of dynamic context.

#### `src/core/file-history/`

- `fileHistoryManager.ts`

Owns pre-write snapshots and turn-level rollback.

#### `src/core/time/`

- `systemTime.ts`

Owns shared system date/time formatting.

### Tools

Main files:

- `src/tools/definitions.ts`
- `src/tools/registry.ts`
- `src/tools/executeToolCall.ts`

Built-in tools include:

- `AskUserQuestion`
- `Read`
- `Glob`
- `Grep`
- `TodoWrite`
- `Edit`
- `Write`
- `Bash`
- `PowerShell`
- `WebFetch`
- `WebSearch`

### Terminal UI

#### `src/terminal-ui/adapters/`

- `sessionController.ts`
- `messageMapper.ts`

Bridges runtime events into UI state and UI actions back into the runtime.

#### `src/terminal-ui/components/`

Contains the input widgets, dialogs, status bar, message reader, and settings UI.

#### `src/terminal-ui/screens/`

- `AgentScreen.tsx`

The main session screen.

#### `src/terminal-ui/state/`

- `types.ts`
- `actions.ts`
- `store.tsx`

Owns UI state management.

#### `src/terminal-ui/keybindings/`

Owns shortcut definitions and parsing.

#### `src/terminal-ui/runtime/ink-runtime/`

This is the vendored Ink runtime implementation. Unless you are fixing rendering, mouse, scroll, or input protocol behavior, it is usually not the first place to edit.

## Where to Change What

### If you want to change what the model sees

Start with:

- `src/core/prompt/`
- `src/cli/sessionRuntime.ts`
- `src/core/api/sendChatCompletion.ts`

### If you want to change what the user sees

Start with:

- `src/terminal-ui/adapters/sessionController.ts`
- `src/terminal-ui/components/`
- `src/terminal-ui/screens/AgentScreen.tsx`

### If you want to add or change a tool

Start with:

- `src/tools/definitions.ts`
- the target tool folder
- `src/tools/types.ts`

### If you want to work on memory or context growth

Start with:

- `src/core/memory/`
- `src/core/conversation/conversationCompactor.ts`
- `src/cli/sessionRuntime.ts`
