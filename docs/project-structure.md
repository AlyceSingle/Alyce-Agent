<p align="center">
  English | <a href="./zh-CN/project-structure.md">简体中文</a>
</p>

# Project Structure

I am Alyce. This document provides a comprehensive overview of the Alyce codebase, its architectural layers, and guidance for development and extension.

## Top-Level Directory Structure

```text
.
├─ src/            ← Source code
├─ docs/           ← Project documentation
├─ dist/           ← TypeScript compilation output
├─ .alyce/         ← Runtime state: config, memory, session history, skills, MCP output
├─ User_Info/      ← User-owned data (not part of the repository)
└─ README.md       ← Main entry point
```

Note: The `.alyce/` directory is automatically generated at runtime. Please avoid manual modifications to its content.

## Core Modules in `src/`

### Entry & Startup

```
src/index.ts
src/cli/startReactUiMode.ts
```

Handles environment initialization:
- Loads environment variables.
- Validates the TTY environment.
- Initializes the Runtime, UI Store, and Session Controller.
- Hands control over to the React UI.

### CLI & Session Assembly

```
src/cli/sessionRuntime.ts
src/cli/commandRouter.ts
src/cli/contextPreview.ts
```

The middle layer connecting the model to the UI:
- Maintains the message chain.
- Merges configuration, memory, and compaction rules.
- Parses slash commands like `/help`, `/remember`, and `/resume`.
- Generates `/context` request previews.

### Core Runtime

#### `src/core/agent/`
Contains `runAgentTurn.ts`, which manages the main agent loop: calling the model, parsing tool requests, and executing tools.

#### `src/core/api/`
Handles actual HTTP communication with the model API, including payload shaping and timestamp injection.

#### `src/core/memory/`
Manages memory services, including persistent storage, auto-summary generation, and prompt injection logic.

#### `src/core/conversation/`
Contains `conversationCompactor.ts`, which compresses older turns to prevent exceeding the model's context window.

#### `src/core/session-history/`
Manages project-local session records (JSONL format), enabling conversation restoration via `/resume`.

#### `src/core/prompt/`
Handles dynamic system prompt construction, including static rules, environment info, and persona overlays.

#### `src/core/file-history/`
Records snapshots before file writes to support operation rollbacks.

### MCP Runtime

#### `src/mcp/`
Loads `./.alyce/mcp.json`, manages MCP client transports, exposes dynamic MCP tools, and backs `McpStatus`, `ListMcpResources`, and `ReadMcpResource`.

### Tools

```
src/tools/definitions.ts
src/tools/registry.ts
```

Defines all available tools (e.g., `Read`, `Edit`, `Bash`, `WebSearch`). Each tool includes its own definition, execution logic, and approval rules.

Local skills live under `./.alyce/skills/**/SKILL.md` or `~/.alyce/skills/**/SKILL.md` and are loaded through `SkillTool`. Binary MCP resources are written under `./.alyce/mcp-output/`.

### Terminal UI

An interactive interface built with React + Ink.
- `adapters/`: Bridge between runtime events and UI state.
- `components/`: Visual components (inputs, dialogs, status bar, etc.).
- `screens/`: Top-level screen components.
- `state/`: UI state management logic.

## Quick Reference for Developers

| Goal | Entry Point |
|---|---|
| Modify model instructions | `src/core/prompt/` |
| Change the user interface | `src/terminal-ui/` |
| Add or modify tool functionality | `src/tools/` |
| Adjust memory or context logic | `src/core/memory/` or `src/core/conversation/` |
| Fix startup-related issues | `src/index.ts` or `src/cli/startReactUiMode.ts` |

---

This map is intended to help you navigate and contribute to the Alyce project more effectively.
