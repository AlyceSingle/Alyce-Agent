# Repository Guidelines

## Project Structure & Module Organization
All runtime code lives in `src/`. Entry starts at `src/index.ts`, then flows through `src/cli/` for session startup and command routing, `src/config/` for runtime settings, `src/core/` for agent, API, prompt, memory, and abort logic, `src/tools/` for built-in tools, and `src/terminal-ui/` for the Ink-based TTY UI. Build output goes to `dist/`. Workspace state and local memory live under `.alyce/`; treat that as generated local data, not source.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run build`: compile TypeScript with `tsc` into `dist/`.
- `npm run dev`: build, then launch the terminal UI locally.
- `npm start`: run the compiled app from `dist/index.js`.

This app must be run in an interactive TTY. Use `npm run build` as the baseline validation step before submitting changes.

## Coding Style & Naming Conventions
Use TypeScript with 2-space indentation, semicolons, double quotes, and explicit `.js` extensions in relative imports. Prefer feature folders over file-type grouping. Use `PascalCase` for React components and tool classes such as `WebSearchTool.ts`, and `camelCase` for helpers such as `sessionRuntime.ts` or `runAgentTurn.ts`. No dedicated formatter or linter is configured, so match the surrounding code closely.

## Testing Guidelines
No automated test framework is configured yet. Validate changes with `npm run build`, then manually exercise affected flows in `npm run dev`, especially TTY UI behavior, tool approvals, prompt assembly, and memory persistence. If you add tests, place `*.test.ts` or `*.test.tsx` beside the module they cover.

## Commit & Pull Request Guidelines
Recent commit subjects are short, imperative, and action-first, for example `Refine UI framework` or `Refactor API settings`. Follow that pattern and keep the subject to one line. Pull requests should include a concise summary, impacted areas, manual verification steps, and screenshots for terminal UI changes when helpful.

## Security & Configuration Tips
Do not commit `.env`, `.alyce/`, or generated `dist/` output. Keep workspace path checks, approval gates, and tool sandbox behavior intact when editing `src/tools/` or command execution flows. Document any new environment variables in `README.md` and `.env.example`.
