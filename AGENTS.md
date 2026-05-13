# Repository Guidelines

## Project Structure & Module Organization
All runtime code lives in `src/`. Entry starts at `src/index.ts`, then flows through `src/cli/` for session startup and command routing, `src/config/` for runtime settings, `src/core/` for agent, API, prompt, memory, and abort logic, `src/tools/` for built-in tools, and `src/terminal-ui/` for the Ink-based TTY UI. Build output goes to `dist/`. Workspace state and local memory live under `.alyce/`; treat that as generated local data, not source.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run build`: compile TypeScript with `tsc` into `dist/`.
- `npm test`: discover and run all `src/**/*.test.ts(x)` files with `tsx`.
- `npm test -- <fragment>`: run tests whose path contains the fragment, for example `npm test -- commandRouter`.
- `npm run dev`: build, then launch the terminal UI locally.
- `npm start`: run the compiled app from `dist/index.js`.

This app must be run in an interactive TTY. Use `npm run build` and `npm test` as the baseline validation steps before submitting changes.

## Coding Style & Naming Conventions
Use TypeScript with 2-space indentation, semicolons, double quotes, and explicit `.js` extensions in relative imports. Prefer feature folders over file-type grouping. Use `PascalCase` for React components and tool classes such as `WebSearchTool.ts`, and `camelCase` for helpers such as `sessionRuntime.ts` or `runAgentTurn.ts`. No dedicated formatter or linter is configured, so match the surrounding code closely.

## Testing Guidelines
Tests are plain `*.test.ts` or `*.test.tsx` files run directly with `tsx` through `npm test`. Place new tests beside the module they cover. Validate changes with `npm run build` and `npm test`, then manually exercise affected TTY flows in `npm run dev` when the change touches UI behavior, tool approvals, prompt assembly, or memory persistence.

## Commit & Pull Request Guidelines
Recent commit subjects are short, imperative, and action-first, for example `Refine UI framework` or `Refactor API settings`. Follow that pattern and keep the subject to one line. Pull requests should include a concise summary, impacted areas, manual verification steps, and screenshots for terminal UI changes when helpful.

## Security & Configuration Tips
Do not commit `.env`, `.alyce/`, or generated `dist/` output. Keep workspace path checks, approval gates, and tool sandbox behavior intact when editing `src/tools/` or command execution flows. Document any new environment variables in `README.md` and `.env.example`.
