<h1 align="center">Alyce</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/alyce"><img src="https://img.shields.io/npm/v/alyce.svg" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/AlyceSingle/Alyce-Agent/stargazers"><img src="https://img.shields.io/github/stars/AlyceSingle/Alyce-Agent.svg?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  A careful terminal coding companion for local, tool-using workflows.
</p>

<p align="center">
  English | <a href="https://github.com/AlyceSingle/Alyce-Agent/blob/master/.github/readme-zh_cn.md">简体中文</a>
</p>

> [!IMPORTANT]
> **Project Status**: This is a **learning project** focused on building a terminal-first coding agent. It is currently in an experimental stage and is provided "as-is". While I am actively working on it, please expect breaking changes and use it with caution in production environments. Feedback and contributions are more than welcome!

I am Alyce, a terminal-first coding agent designed to be your engineering partner. Built with TypeScript, React, and Ink, I focus on providing an explicit and controllable runtime. My core principles include layered prompt assembly, strict tool approval boundaries, and efficient memory management, all while operating directly within your interactive TTY.

## What Alyce is

Alyce is a local coding assistant framework with:

- an interactive terminal UI
- multi-step tool-using agent turns
- prompt composition with persona and runtime sections
- resumable project session history, session memory, persistent memory, auto-summary, and conversation compaction
- approval-aware command, file, and web tooling
- `/doctor` local diagnostics and read-only `/plan` mode
- built-in subagents for implementation, exploration, review, and verification checks
- local `SkillTool` loading from project/user `SKILL.md` files
- MCP server integration for stdio, streamable HTTP, and SSE tools/resources

## Quick Start

### Global Installation (Recommended)

You can install Alyce globally via npm:

```bash
npm install -g alyce@latest
```

Then start it from anywhere:

```bash
alyce
```

### Local Development

1. Install dependencies

```bash
npm install
```

2. Create `.env` from the template

```bash
copy .env.example .env
# or: cp .env.example .env
```

3. Fill in at least:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

You can also configure provider profiles in `.alyce/config.json` or `~/.alyce/config.json` and switch with `/model provider/model`; run `/model` in Alyce to inspect configured providers and examples.

Optional tuning includes `ALYCE_WEB_FETCH_CACHE_MAX_BYTES` (WebFetch cache budget), `AGENT_MARKDOWN_TOOL_RENDERING_ENABLED`, `AGENT_MARKDOWN_RENDER_MAX_CHARS`, `AGENT_SCROLL_SPEED`, and `AGENT_HISTORY_PAGING_ENABLED`; see [Configuration](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/configuration.md) for the full list.

4. Start Alyce

```bash
npm run dev
```

Or build first, then run:

```bash
npm run build
npm start
```

Run the local validation suite with:

```bash
npm test
```

You can run a subset by passing a path or name fragment, for example `npm test -- commandRouter`.

### First Checks

After Alyce starts, run:

```text
/doctor
```

Use the doctor report to fix missing config, TTY problems, stale build output, approval risk, MCP config issues, skill discovery issues, missing `rg`/`git`, or `.alyce` storage problems.

For analysis before edits, enter:

```text
/plan
```

Plan Mode keeps exploration read-only. Use `/plan exit` or `/build` to leave it when you are ready for implementation work. In Alyce, `/build` is only a Plan Mode exit alias; it does not run `npm run build`.

### VS Code terminal context

You can launch Alyce from a VS Code integrated terminal with explicit editor context:

```bash
alyce --cwd "C:\path\to\workspace" --context-file "src/index.ts" --initial-prompt "Review this file"
```

For selected text, write it to a file first, then pass it with `--selection-file`:

```bash
alyce-vscode-selection --out ".alyce/vscode-selection.txt" --selection "selected text"
alyce --cwd . --selection-file ".alyce/vscode-selection.txt" --initial-prompt "Review this selection"
```

These flags inject context for the next turn only; they do not read the whole workspace or grant write approval. See [Getting Started](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/getting-started.md) for VS Code task/keybinding snippets.

## Documentation

- [Documentation Index](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/README.md)
- [Getting Started](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/getting-started.md)
- [Project Structure](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/project-structure.md)
- [Commands and Keys](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/commands-and-keys.md)
- [Configuration](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/configuration.md)
- [Memory and Context](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/memory-and-context.md)
- [Persona Presets](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/persona-presets.md)
- [Contributing](https://github.com/AlyceSingle/Alyce-Agent/blob/master/CONTRIBUTING.md)
- [Security](https://github.com/AlyceSingle/Alyce-Agent/blob/master/SECURITY.md)

## Project Notes

- This app must run in an interactive TTY
- `npm run dev` is a build-then-run workflow, not a hot-reload dev server
- Project-level runtime state lives in `./.alyce/`
- User-level runtime state lives in `~/.alyce/`
- Local skills live in `.alyce/skills/**/SKILL.md`; MCP servers are configured in `.alyce/mcp.json`

I recommend reading the [Project Structure](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/project-structure.md) documentation if you plan to maintain or extend the codebase. Understanding the architectural layers will ensure a more predictable development experience.
