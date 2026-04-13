# Repository Guidelines

## Project Structure & Module Organization
`src/` contains all runtime code. Entry starts at `src/index.ts`, then flows through `src/cli/` for session startup, `src/config/` for runtime settings, `src/core/` for agent, prompt, API, and memory logic, `src/tools/` for built-in tool implementations, and `src/terminal-ui/` for the Ink React interface. Build output goes to `dist/`. Local state lives under `.alyce/`; treat it as workspace data, not source.

## Build, Test, and Development Commands
Run `npm install` to install dependencies. Use `npm run dev` to launch the agent in development mode through `tsx`; this must run in an interactive TTY. Use `npm run build` to compile TypeScript into `dist/`, and `npm start` to run the compiled app with Node. There is no separate lint or test script yet, so `npm run build` is the baseline validation step.

## Coding Style & Naming Conventions
This repo uses strict TypeScript with NodeNext modules and React JSX. Match the existing style: 2-space indentation, semicolons, double quotes, and explicit `.js` extensions in relative imports from TypeScript files. Use `PascalCase` for React components and class-like files such as `WebSearchTool.ts`, and `camelCase` for helpers such as `sessionRuntime.ts` or `runAgentTurn.ts`. Keep modules grouped by feature folder rather than by file type.

## Testing Guidelines
No automated test framework or coverage gate is configured today. For every change, run `npm run build` and then manually exercise the affected flow with `npm run dev`, especially for TTY-only UI behavior, tool approvals, prompt assembly, and memory persistence. If you add tests, prefer colocated `*.test.ts` or `*.test.tsx` files beside the module they cover.

## Commit & Pull Request Guidelines
Recent commits use short, imperative subjects such as `Add PowerShellTool`, `Refactoring tools`, and `Fix command issues/add auto-summarization`. Follow that pattern: one-line, action-first summaries focused on the user-visible change. Pull requests should include a concise description, impacted areas, manual verification steps, and terminal screenshots when UI behavior changes. Link related issues and note any new environment variables in `.env.example`.

## Security & Configuration Tips
Never commit `.env`, `.alyce/`, or generated `dist/` output. Keep approval and sandbox logic intact when editing tool execution paths, and document any new configuration keys in both `README.md` and `.env.example`.
