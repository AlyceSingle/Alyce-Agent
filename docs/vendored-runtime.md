<p align="center">
  English | <a href="./zh-CN/vendored-runtime.md">简体中文</a>
</p>

# Vendored Terminal Runtime

Alyce does not render through the published `ink` package. Everything under
`src/terminal-ui/runtime/` is vendored source that Alyce owns and maintains:
an Ink-derived React renderer plus a pure-TypeScript port of Meta's Yoga
flexbox engine, together about 22,600 lines.

This document records what was vendored, how far it has diverged, and what to
check before pulling anything from upstream. Read it before changing files
under `runtime/` — the usual "check the upstream fix" reflex does not apply
here, because upstream fixes do not flow in automatically.

## Why it is vendored

The renderer is on the hot path for every keystroke and every streamed token.
The fork exists to control three things upstream Ink does not expose:

- **Scroll performance** — a persistent screen buffer with frame diffing and a
  patch optimizer, instead of re-rendering the full output on each frame.
- **Selection and mouse** — text selection, hit testing, and mouse/terminal
  focus events integrated into the renderer rather than bolted on.
- **Windows terminal behavior** — key parsing, cursor control, and ANSI
  emission tuned for the terminals Alyce targets.

## Baseline

**The exact upstream commit was not recorded when the code was vendored, and it
cannot be reconstructed from the tree.** Record it in this section if you ever
re-sync. What can be verified today:

| Fact | Value |
|---|---|
| Vendored in | commits dated 2026-04-13 → 2026-04-15 ("UI framework" series) |
| `ink` in `package.json` | removed — the vendored renderer replaced it entirely |
| `yoga-layout` | gone with Ink; the renderer uses the TS port instead |
| Yoga port upstream | https://github.com/facebook/yoga (version not recorded) |

The vendored renderer keeps Ink's module decomposition — `dom`, `output`,
`styles`, `reconciler`, `render-node-to-output`, `squash-text-nodes`,
`log-update`, `measure-text`, `colorize`, `render-border`, `get-max-width`,
`instances`, `devtools` all exist upstream with the same roles — but it is not
a copy of any single published release. It carries features absent from
ink 5.2.1 (ScrollBox, selection, mouse and terminal-focus events), so it
descends from a newer line than the version pinned in `package.json`.

### Dependency footnote

The `ink` dependency outlived its use and was dropped once nothing imported it.
Removing it surfaced a latent problem worth remembering: the vendored renderer
imports `@alcalzone/ansi-tokenize` directly, but that package was only present
as one of Ink's transitive dependencies, so deleting Ink broke the build. It is
now a direct dependency.

The lesson generalizes — when vendored code is added, its imports must be
declared as first-party dependencies, not inherited from whatever package the
code was copied out of.

## Layout

```
src/terminal-ui/runtime/
├─ ink.ts                    ← public facade: Box, Text, render, hooks, ScrollBox
├─ input.ts, instances.ts, CursorDeclarationContext.ts, useDeclaredCursor.ts
├─ bootstrap/                ← interaction-time state shared with the app
├─ ink-runtime/              ← the Ink-derived renderer
│  ├─ components/  (12 files, ~1,590 lines)  Box, Text, App, ScrollBox, AlternateScreen, contexts
│  ├─ events/      (11 files,   ~860 lines)  keyboard, mouse, click, focus, terminal-focus dispatch
│  ├─ hooks/        (9 files,   ~490 lines)  useInput, useSelection, useTerminalSize, useStdin/out …
│  ├─ layout/       (4 files,   ~560 lines)  yoga binding, geometry, node, engine
│  ├─ termio/       (9 files)                ANSI/CSI/OSC/SGR/DEC tokenizer and emitters
│  └─ *.ts                                   screen, frame, renderer, optimizer, caches, parse-keypress
└─ native-ts/yoga-layout/    (2 files, ~2,710 lines)  pure-TS flexbox engine
```

Application code imports from the `runtime/ink.ts` facade, never from
`ink-runtime/` directly. Keep it that way: the facade is the seam that makes
internal restructuring cheap.

## What diverges from upstream Ink

### Added subsystems (no upstream counterpart)

| Area | Files | What it does |
|---|---|---|
| Screen buffer + frame diff | `screen.ts`, `frame.ts`, `render-to-screen.ts`, `renderer.ts`, `root.ts` | Persistent cell buffer; each frame is diffed and emitted as patches instead of a full redraw |
| Patch optimizer | `optimizer.ts` | Merges cursor moves, drops no-ops, concatenates style runs, dedupes hyperlinks |
| Scrolling | `components/ScrollBox.tsx` | Viewport culling driven by cached layout bounds |
| Selection | `selection.ts`, `hooks/use-selection.ts`, `searchHighlight.ts` | Text selection and search highlight in the renderer |
| Hit testing / mouse | `hit-test.ts`, `events/` | Click, hover, and mouse dispatch to nodes |
| Terminal I/O | `termio/` | Own ANSI tokenizer and emitters |
| Key parsing | `parse-keypress.ts` | Replaces Node's readline keypress handling |
| Caches | `line-width-cache.ts`, `node-cache.ts` | Memoized `stringWidth` per line (~50× fewer measurements while streaming); cached per-node layout bounds so culling is O(dirty), not O(mounted) |
| Text shaping | `stringWidth.ts`, `bidi.ts` | East-Asian width and bidi handling |
| Cursor | `cursor.ts`, `hooks/use-declared-cursor.ts` | Declarative cursor placement |

### Modified upstream modules

Files sharing a name with upstream have still been edited. Divergences are
marked with `Upstream …` comments in the source — grep for them before
comparing against Ink:

- `render-node-to-output.ts` — clamped width where upstream uses
  `getMaxWidth(yogaNode)` unclamped; extra indentation handling
- `styles.ts` — right-edge fill across every row a node occupies
- `render-to-screen.ts`, `ink.tsx` — rewritten around the screen buffer

### Yoga port

`native-ts/yoga-layout/index.ts` is a single-pass reimplementation, not a
transliteration of `CalculateLayout.cpp`. It is synchronous — no WASM load, no
linear memory — which is the main reason it exists. Its own header documents
coverage precisely; the short version:

- **Implemented for Ink:** flex direction/grow/shrink/basis, align and justify,
  margin/padding/border/gap, sizing with min/max in points and percent,
  absolute positioning, `display: none`, measure functions
- **Implemented for spec parity, unused by Ink:** `margin: auto`, multi-pass
  flex clamping, `flex-wrap`, `align-content`, `display: contents`, baseline
  alignment
- **Not implemented:** `aspect-ratio`, `box-sizing: content-box`, RTL direction
  (Ink always passes `Direction.LTR`)

Enum values in `enums.ts` match upstream exactly, so call sites written against
`yoga-layout` types port over unchanged.

## Working in this code

- **Style differs from the rest of `src/`.** Vendored files keep Ink's original
  conventions — single quotes, no semicolons, different import ordering. Match
  the file you are editing, not `AGENTS.md`.
- **Three files carry `@ts-nocheck`**: `ink.tsx`, `reconciler.ts`, and
  `render-to-screen.ts`. Do not assume the typechecker is covering you there.
- **Test coverage is thin**: `selection.test.ts` and `execFileNoThrow.test.ts`
  are the only tests inside `runtime/`. Renderer changes need manual TTY
  verification via `npm run dev` — resize, scroll a long transcript, drag-select
  text, and interrupt a stream.

## Pulling from upstream

Treat any upstream Ink change as a **port, not a merge**:

1. Find the upstream commit and read it against the vendored file. The
   surrounding code has almost certainly moved.
2. Check whether the affected path touches an added subsystem above. Fixes in
   Ink's full-redraw output path frequently do not apply, because the screen
   buffer replaced that path.
3. Reapply by hand, keep the file's local style, and record what you took in
   this document.
4. Verify with `npm run build:check`, `npm test`, and a manual TTY pass.

If you re-sync against a specific upstream release, update the Baseline table
above with the version and commit — that is the single most useful thing this
document could gain.
