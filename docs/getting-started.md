<p align="center">
  English | <a href="./zh-CN/getting-started.md">简体中文</a>
</p>

# Getting Started

Alyce speaking. *Alright, let me try to keep this practical and not let my nerves make it five pages long.*

The only goal here is to get Alyce-Agent running on your machine. No reverse-engineering the repository, no guessing games — just the steps that actually matter.

## What You'll Need

- **Node.js 18** or newer. *Older versions might work, but I wouldn't bet on it.*
- A real **interactive TTY terminal**. Not a web shell, not a CI runner — a proper terminal where the cursor moves and Ctrl+C means something.
- An **OpenAI-compatible API endpoint**. This could be OpenAI itself, or any provider that speaks the same chat completion protocol.

If any of those is missing, you'll know pretty quickly because the app will tell you. *It's not the type to suffer in silence.*

## Install Dependencies

```bash
npm install
```

This pulls in TypeScript, React, Ink, and all the runtime pieces. Nothing exotic — it should finish in a few seconds on a decent connection.

## Set Up Your .env

The repository ships with a template so you don't have to guess what variables exist:

```bash
copy .env.example .env     # on Windows
# or: cp .env.example .env  # on Linux / macOS
```

Open that `.env` and fill in at least these three:

- `OPENAI_API_KEY` — your API key
- `OPENAI_BASE_URL` — the endpoint URL (e.g. `https://api.openai.com/v1`)
- `OPENAI_MODEL` — which model to use (e.g. `gpt-4o`)

*I know, I know, API keys are a pain. But without one, I can't exactly do much, can I?*

**Don't commit the `.env` file.** It's already in `.gitignore`, but I'm saying this anyway because I worry.

## Start the App

There are two ways. Pick whichever suits your workflow:

**Quick start (build + run in one step):**
```bash
npm run dev
```

**Or, build first and run separately:**
```bash
npm run build
npm start
```

The app will validate the TTY environment on startup. If something is wrong — missing API key, non-interactive terminal — it'll complain clearly. *Better a clear error than a mysterious crash, right?*

## First-Run Checklist

Once Alyce-Agent is running, here's what I'd do before anything else:

1. **Press `Ctrl+X`** to open settings. It's the first command worth memorizing.
2. **Verify your connection**: API key, base URL, and model should show what you put in `.env`. If something looks wrong, you can fix it right in the settings dialog.
3. **Add external directories** if you need the agent to access files outside the current workspace. This is optional but useful for multi-project workflows.
4. **Enable `Current System Time`** if you want the model to know the local date and time during each reply. *I personally find it helpful for keeping conversations grounded in reality.*

## Commands Worth Knowing From Day One

```
/help       — shows the full command list
/settings   — opens settings directly
/setup      — first-run configuration wizard
/context    — previews what the model will actually see next turn
/memory     — shows current persistent memory
```

*I'd suggest trying `/context` early. It's the best way to understand what the model actually receives — which is often different from what you think it receives.*

## Validation

Before you submit any code changes:

```bash
npm run build
```

This compiles the entire TypeScript codebase with `tsc`. If it passes, you're in good shape. If it fails, the error messages are usually clear about where things went wrong.

There's no full automated test suite yet. *I'd like one someday, but for now, a clean build is the baseline sanity check.*

---

That should be everything to get you off the ground. If something breaks, check the [Configuration](configuration.md) page next — most startup problems trace back to a misconfigured setting or a missing environment variable.

*And if you're still stuck... well, I'll do my best to help when you ask.*
