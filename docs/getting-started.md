<p align="center">
  English | <a href="./zh-CN/getting-started.md">简体中文</a>
</p>

# Getting Started

I am Alyce. This guide will help you set up the environment and get Alyce running on your machine.

## Prerequisites

- **Node.js 18** or newer.
- A real **interactive TTY terminal** (supports cursor movement and standard keybindings).
- An **OpenAI-compatible API endpoint**.

If any of these are missing, the app will provide a clear error message on startup.

## Global Installation (Recommended)

The easiest way to use Alyce is to install it globally via npm:

```bash
npm install -g alyce@latest
```

Then you can start it from any directory by simply typing:

```bash
alyce
```

## Local Development (Install Dependencies)

```bash
npm install
```

This installs TypeScript, React, Ink, and all necessary runtime dependencies.

## Set Up Your .env

The repository includes a template file for your environment variables:

```bash
copy .env.example .env     # Windows
# or: cp .env.example .env  # Linux / macOS
```

Open `.env` and fill in at least these three fields:

- `OPENAI_API_KEY` — your API key
- `OPENAI_BASE_URL` — the endpoint URL (e.g., `https://api.openai.com/v1`)
- `OPENAI_MODEL` — the model name to use (e.g., `gpt-4o`)

**Security Note:** Do not commit your `.env` file to Git. It is ignored by default in `.gitignore`.

## Start the App

You can choose the startup method that fits your workflow:

**Quick Start (build and run in one step):**
```bash
npm run dev
```

**Or, build first and run separately:**
```bash
npm run build
npm start
```

The app validates the TTY environment on startup. If the configuration is incorrect (e.g., missing API key or non-interactive terminal), it will provide a clear error message.

## First-Run Recommendations

Once Alyce is running, we recommend the following steps:

1. **Press `Ctrl+X`** to open the settings panel.
2. **Verify your connection**: Ensure the API key, base URL, and model match your `.env` configuration.
3. **Add external directories** if you need the agent to access files outside the current workspace.
4. **Enable `Current System Time`** if you want the model to be aware of the local date and time during each turn.

## Essential Commands

```
/help       — shows the full command list
/settings   — opens settings directly
/setup      — first-run configuration wizard
/context    — previews what the model will actually see next turn
/memory     — shows current persistent memory
```

We suggest trying `/context` early to understand how the model receives information, including memory and summaries.

## Validation

Before submitting any code changes, please run:

```bash
npm run build
```

This performs a full TypeScript compilation. While a comprehensive test suite is not yet available, a clean build is the baseline requirement for stability.

---

If you encounter issues, please refer to the [Configuration](configuration.md) page.
