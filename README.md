<h1 align="center">Alyce</h1>

<p align="center">
  A careful terminal coding companion for local, tool-using workflows.
</p>

<p align="center">
  English | <a href="./.github/readme-zh_cn.md">简体中文</a>
</p>

> [!IMPORTANT]
> **Project Status**: This is a **learning project** focused on building a terminal-first coding agent. It is currently in an experimental stage and is provided "as-is". While I am actively working on it, please expect breaking changes and use it with caution in production environments. Feedback and contributions are more than welcome!

Alyce speaking. This repository hosts a terminal-first coding agent built with TypeScript, React, and Ink as part of a learning journey into agentic workflows. I try to keep the runtime explicit and serviceable: prompts are assembled in layers, tools respect approval boundaries, memory is kept under control, and the whole app stays grounded in a real interactive TTY instead of a browser shell.

## What Alyce is

Alyce is a local coding assistant framework with:

- an interactive terminal UI
- multi-step tool-using agent turns
- prompt composition with persona and runtime sections
- resumable project session history, session memory, persistent memory, auto-summary, and conversation compaction
- approval-aware command, file, and web tooling
- rollback support for interrupted file edits

## Highlights

- Terminal-native UI: React + Ink, including dialogs, message viewer, and settings
- Tool loop: the model can call multiple tools in one turn before returning a final answer
- Richer local inspection: `Read` now handles text files, directory listings, notebook summaries, missing-path suggestions, capped continuation reads, on-demand external directory approval, and true multimodal image/PDF attachment flow for supported formats, while still reporting metadata such as image dimensions
- Prompt engineering: static rules, dynamic environment, and persona overlays are assembled into one system prompt
- Session resume: project-local JSONL transcripts let `/resume` reopen earlier conversations
- Rewind: `Esc` or `/rewind` can restore an earlier prompt, with tracked file rollback when available
- Context control: message timestamps, memory injection, auto-summary, and compaction work together to keep prompts useful instead of bloated
- Safety rails: scoped external-directory approvals, file access scope, UNC path blocking on Windows, approval gates, per-file write locks, raw-byte pre-write snapshots, read-before-write freshness checks with content fallback, byte-level approval-window rechecks, encoding/line-ending preservation, robust edit matching, `MultiEdit`, opencode-style `apply_patch`, and post-edit/write formatter plus TypeScript/JavaScript diagnostics are built into the runtime

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

Optional web tuning includes `ALYCE_WEB_FETCH_CACHE_MAX_BYTES` for the total in-memory WebFetch cache budget; see [Configuration](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/configuration.md) for the full list.

4. Start Alyce

```bash
npm run dev
```

Or build first, then run:

```bash
npm run build
npm start
```

## Documentation

- [Documentation Index](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/README.md)
- [Getting Started](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/getting-started.md)
- [Project Structure](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/project-structure.md)
- [apply_patch Tool](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/apply-patch-tool.md)
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
- `User_Info/` is treated as user data, not as project documentation

## Validation

The minimum validation step before submitting changes is:

```bash
npm run build
```

I would recommend reading [Project Structure](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/project-structure.md) first if you plan to maintain the codebase. It is... a little easier on the nerves when the layers are clear.
