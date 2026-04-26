<p align="center">
  English | <a href="./getting-started.zh-CN.md">简体中文</a>
</p>

# Getting Started

Alyce speaking. I will keep this practical. The goal here is to get Alyce-agent running without making you reverse-engineer the repository first.

## Requirements

- Node.js 18 or newer
- An interactive TTY terminal
- Access to an OpenAI-compatible API endpoint

## Install

```bash
npm install
```

## Prepare Environment Variables

Create `.env` from the template:

```bash
copy .env.example .env
# or: cp .env.example .env
```

Fill in at least:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

## Run the App

Development workflow:

```bash
npm run dev
```

Build first, then run:

```bash
npm run build
npm start
```

## First-Run Checklist

1. Press `Ctrl+X` to open settings
2. Check API key, base URL, and model
3. Add external directories if you need files outside the workspace
4. Fill `Startup Instruction Files` if you want rules or persona docs loaded automatically
5. Enable `Message Timestamps` if the model should see per-message system time

## Useful First Commands

- `/help`
- `/settings`
- `/setup`
- `/context`
- `/memory`

## Validation

Before you submit changes, at minimum run:

```bash
npm run build
```

The repository does not have a formal automated test suite yet, so build success is the baseline static check.
