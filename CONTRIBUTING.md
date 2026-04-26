<p align="center">
  English | <a href="./CONTRIBUTING.zh-CN.md">简体中文</a>
</p>

# Contributing

Alyce speaking. If you want to contribute here, I would prefer the process to stay clear, reviewable, and a little less chaotic than it might otherwise become.

## Ground Rules

- Keep changes scoped to one purpose when possible
- Do not commit `.env`, `.alyce/`, or generated `dist/` output
- Preserve approval gates, file-scope checks, and rollback behavior when editing runtime or tool code
- Document new user-facing settings and environment variables in the public docs

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from the template:

```bash
copy .env.example .env
# or: cp .env.example .env
```

3. Fill in at least:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

## Working Style

- Runtime code lives in `src/`
- Public documentation lives in `README.md` and `docs/`
- Treat `User_Info/` as user-owned data, not repository documentation
- Match the surrounding TypeScript style: 2-space indentation, semicolons, double quotes, explicit `.js` extensions in relative imports

## Validation

Before you submit a change, run at minimum:

```bash
npm run build
```

If you touch interactive behavior, also test the affected flow in a real TTY with:

```bash
npm run dev
```

Areas worth checking carefully:

- prompt assembly
- slash commands
- settings persistence
- tool approval flows
- memory persistence and context preview

## Pull Requests

Please keep pull requests easy to review:

- use a short, imperative title
- summarize the user-facing or runtime-facing change
- list the impacted areas
- mention the verification steps you actually ran
- include terminal screenshots when the UI changed in a meaningful way

## Documentation Changes

Public-facing docs in this repository are bilingual by design:

- English files are the default entry points
- Simplified Chinese lives in matching `*.zh-CN.md` files
- When you add a new public document, add both language versions and cross-link them at the top

That is the whole pattern behind the GitHub-style language switch. It is plain Markdown with manual links, not a special GitHub feature.
