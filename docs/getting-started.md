<p align="center">
  English | <a href="./zh-CN/getting-started.md">简体中文</a>
</p>

# Getting Started

I am Alyce. This guide will help you set up the environment and get Alyce running on your machine.

## Prerequisites

- **Node.js 20.10.0** or newer.
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

Open `.env` and fill in the legacy OpenAI-compatible startup defaults when you want to start from environment variables:

- `OPENAI_API_KEY` — your API key
- `OPENAI_BASE_URL` — the endpoint URL (e.g., `https://api.openai.com/v1`)
- `OPENAI_MODEL` — the model name to use (e.g., `gpt-4o`)

You can also skip editing `.env` for common providers and run `/connect` inside Alyce. The provider picker supports OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Kimi, Qwen, SiliconFlow, Doubao, Ollama, LM Studio, and custom OpenAI-compatible endpoints. Secret fields are masked and saved to `~/.alyce/auth.json`.

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

## VS Code Integrated Terminal Helper

You can pass the current editor file or a selection file into Alyce from a VS Code integrated terminal without installing a marketplace extension:

```bash
alyce --cwd "C:\path\to\workspace" --context-file "src/index.ts" --initial-prompt "Review this file"
```

For local development, use `npm run dev --` before the Alyce flags:

```bash
npm run dev -- --context-file "src/index.ts" --initial-prompt "Review this file"
```

Example `.vscode/tasks.json` task for the current file:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Alyce: Current File",
      "type": "shell",
      "command": "alyce",
      "args": [
        "--cwd",
        "${workspaceFolder}",
        "--context-file",
        "${file}",
        "--initial-prompt",
        "Use the provided editor file as context."
      ],
      "problemMatcher": []
    }
  ]
}
```

For selected text, write the selection to a file first, then pass that file explicitly. The `alyce-vscode-selection` helper accepts `--selection`, `ALYCE_VSCODE_SELECTION`, or stdin and writes a UTF-8 file:

```bash
alyce-vscode-selection --out ".alyce/vscode-selection.txt" --selection "selected text"
alyce --cwd . --selection-file ".alyce/vscode-selection.txt" --initial-prompt "Review this selection"
```

Example `.vscode/tasks.json` tasks for the current file plus selected text:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Alyce: Write Selection",
      "type": "shell",
      "command": "alyce-vscode-selection",
      "args": [
        "--out",
        "${workspaceFolder}/.alyce/vscode-selection.txt"
      ],
      "options": {
        "env": {
          "ALYCE_VSCODE_SELECTION": "${selectedText}"
        }
      },
      "problemMatcher": []
    },
    {
      "label": "Alyce: Current File and Selection",
      "type": "shell",
      "dependsOn": "Alyce: Write Selection",
      "dependsOrder": "sequence",
      "command": "alyce",
      "args": [
        "--cwd",
        "${workspaceFolder}",
        "--context-file",
        "${file}",
        "--selection-file",
        "${workspaceFolder}/.alyce/vscode-selection.txt",
        "--initial-prompt",
        "Use the provided file and selection as context."
      ],
      "problemMatcher": []
    }
  ]
}
```

Security boundaries stay the same: startup file paths must be inside allowed roots, Alyce does not read the whole workspace, and passing context does not grant write approval.

## First Checks

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

## First-Run Recommendations

Once Alyce is running, we recommend the following steps:

1. **Run `/connect`** to choose an AI provider and enter API key, base URL, and model fields.
2. **Run `/model list`** to verify the active provider/model and auth status, or `/model`/`/models` to refresh and switch models for the current provider.
3. **Press `Ctrl+X`** if you want to adjust session/runtime settings.
4. **Add external directories** if you need the agent to access files outside the current workspace.

## Essential Commands

```
/help       — shows the full command list
/doctor     — runs local health checks
/settings   — opens settings directly
/permissions — switches approval and access mode
/connect    — open provider picker
/setup      — open provider picker
/plan       — enters read-only planning mode
/build      — exits Plan Mode; does not run npm run build
/context    — previews what the model will actually see next turn
/memory     — shows current persistent memory
```

We suggest trying `/context` early to understand how the model receives information, including memory and summaries.

## Troubleshooting Flow

If Alyce starts but something feels wrong, use this order:

1. Run `npm run build` to make sure `dist/` is current.
2. Start with `npm start` or `npm run dev` from a real interactive terminal.
3. Run `/doctor` inside Alyce.
4. Fix any failed checks first, then review warnings about approval mode, persistent extra directories, MCP config, skills, missing `rg`, missing `git`, or request patches.

If you want Alyce to inspect before editing, enter `/plan`. While Plan Mode is active, write tools and mutating commands are blocked. Use `/plan exit` or `/build` when you are ready to allow implementation work.

## Validation

Before submitting any code changes, please run:

```bash
npm run build
npm test
```

`npm run build` performs a full TypeScript compilation. `npm test` discovers and runs every `src/**/*.test.ts` and `src/**/*.test.tsx` file with `tsx`.

To run a focused subset, pass a path or name fragment:

```bash
npm test -- commandRouter
npm test -- tools/internal
```

---

If you encounter issues, please refer to the [Configuration](configuration.md) page.
