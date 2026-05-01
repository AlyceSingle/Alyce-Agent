<p align="center">
  English | <a href="./docs/zh-CN/contributing.md">简体中文</a>
</p>

# Contributing

Alyce speaking. *I always get a little nervous writing contribution guides — what if I come across as too demanding? But honestly, a few shared expectations make everything smoother for everyone.*

If you want to contribute to Alyce, here's what I'd ask you to keep in mind. Nothing onerous — just enough to keep the codebase reviewable and the history clean.

## Ground Rules

- **One change, one purpose.** A PR that fixes a bug and refactors three modules and adds a feature is three PRs in a trenchcoat. Please don't.
- **Don't commit `.env`, `.alyce/`, or `dist/`.** These are runtime artifacts and secrets — they don't belong in git.
- **Protect the safety rails.** If you edit runtime or tool code, keep the approval gates, file-scope checks, and rollback behavior intact. Those exist for good reasons.
- **Document new settings.** If you add a user-facing setting or environment variable, update the public docs. A setting nobody knows about might as well not exist.

## Setting Up

```bash
npm install          # pull dependencies
copy .env.example .env  # (or cp on Unix)
# then fill in OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
```

That's it. You're ready to build and run.

## Code Style

Match what's already there:

- 2-space indentation
- Semicolons
- Double quotes
- Explicit `.js` extensions in relative imports
- `PascalCase` for components and tool classes; `camelCase` for utilities

*There's no linter configured yet. I know, I know — but in the meantime, just look at the surrounding code and do what it does.*

## Before You Submit

At minimum:

```bash
npm run build
```

This compiles the full TypeScript codebase. If it passes, your change is at least structurally sound.

If you touched interactive behavior — commands, tools, prompts, UI — also test in a real terminal:

```bash
npm run dev
```

Things worth checking manually:

- **Prompt assembly** — does `/context` show what you expect?
- **Slash commands** — do they still work?
- **Settings persistence** — do changes survive a restart?
- **Tool approval** — do approval gates fire when they should?
- **Memory** — does `/remember` stick and `/memory` show it?

## Pull Requests

Keep it scannable:

- **Title**: short, imperative mood. e.g. "Fix tool timeout handling" not "Fixed a bug with tools."
- **Summary**: what changed from a user or runtime perspective.
- **Impacted areas**: which modules are affected.
- **Verification**: what you actually tested, not what you planned to test.
- **Screenshots**: if the terminal UI changed in a visible way, include one.

## Documentation Convention

Public-facing docs in this repo are bilingual by design:

- English files are the default entry points in `docs/`.
- Simplified Chinese translations live under `docs/zh-CN/`.
- The README translation is at `.github/readme-zh_cn.md`.
- When you add a new doc, create both language versions and cross-link them at the top.

The language-switch appearance on GitHub is just plain Markdown manual links. No magic, no special GitHub features — just a consistent pattern.

---

*I realize this looks like a lot of rules. It's really not — once you've done it once, it's mostly common sense. And I promise I'll be nice in code review. Mostly.*
