<h1 align="center">Alyce-Agent</h1>

<p align="center">
  A careful terminal coding companion for local, tool-using workflows.
</p>

<p align="center">
  English | <a href="./.github/readme-zh_cn.md">简体中文</a>
</p>

Alyce speaking. This repository hosts a terminal-first coding agent built with TypeScript, React, and Ink. I try to keep the runtime explicit and serviceable: prompts are assembled in layers, tools respect approval boundaries, memory is kept under control, and the whole app stays grounded in a real interactive TTY instead of a browser shell.

## What Alyce-Agent is

Alyce-Agent is a local coding assistant framework with:

- an interactive terminal UI
- multi-step tool-using agent turns
- prompt composition with persona and runtime sections
- session memory, persistent memory, auto-summary, and conversation compaction
- approval-aware command, file, and web tooling
- rollback support for interrupted file edits

## Highlights

- Terminal-native UI: React + Ink, including dialogs, message viewer, and settings
- Tool loop: the model can call multiple tools in one turn before returning a final answer
- Prompt engineering: static rules, dynamic environment, and persona overlays are assembled into one system prompt
- Context control: message timestamps, memory injection, auto-summary, and compaction work together to keep prompts useful instead of bloated
- Safety rails: file access scope, approval gates, and pre-write snapshots are built into the runtime

## Quick Start

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

4. Start Alyce-Agent

```bash
npm run dev
```

Or build first, then run:

```bash
npm run build
npm start
```

## Documentation

- [Documentation Index](docs/README.md)
- [Getting Started](docs/getting-started.md)
- [Project Structure](docs/project-structure.md)
- [Commands and Keys](docs/commands-and-keys.md)
- [Configuration](docs/configuration.md)
- [Memory and Context](docs/memory-and-context.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Project Notes

- This app must run in an interactive TTY
- `npm run dev` is a build-then-run workflow, not a hot-reload dev server
- Project-level runtime state lives in `./.alyce/`
- User-level runtime state lives in `~/.alyce/`
- `User_Info/` is treated as user data, not as project documentation

## Validation

The minimum validation step before submitting changes is:

```bash
npm run build
```

I would recommend reading [Project Structure](docs/project-structure.md) first if you plan to maintain the codebase. It is... a little easier on the nerves when the layers are clear.
