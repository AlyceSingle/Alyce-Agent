<p align="center">
  English | <a href="./zh-CN/apply-patch-tool.md">简体中文</a>
</p>

# apply_patch Tool

Alyce includes an `apply_patch` tool for coordinated multi-file edits. It ports the local opencode patch language into Alyce's native TypeScript tool stack instead of shelling out to an external patch command.

## Input

The tool accepts one JSON argument:

```json
{
  "patchText": "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch"
}
```

`patchText` may also be wrapped in a heredoc such as `cat <<'EOF' ... EOF` or `<<EOF ... EOF`.

## Not Unified Diff

This patch language is not standard unified diff syntax. Do not include `---`/`+++` file headers, line-number range headers, or hunks such as `@@ -1,4 +1,4 @@`.

Use `@@` by itself, or `@@ <literal file line>` when you need a search anchor. Alyce tolerates accidental unified range headers by treating them as a bare `@@`, but the prompt tells the model not to generate them.

## Patch Format

Every patch uses this envelope:

```text
*** Begin Patch
[one or more file sections]
*** End Patch
```

Supported sections:

```text
*** Add File: <path>
+new file line

*** Delete File: <path>

*** Update File: <path>
*** Move to: <new-path>
@@ optional context anchor
 unchanged context
-old line
+new line
*** End of File
```

`*** Move to:` is optional and only valid immediately after `*** Update File:`. New file content must be prefixed with `+`.

## Matching Behavior

Update hunks are verified before any file is written. Matching follows the opencode behavior:

- exact line matching
- trailing whitespace trimmed matching
- full trimmed matching
- Unicode punctuation normalization for quotes, dashes, ellipsis, and non-breaking spaces
- `@@ context` anchors seek the target area before matching hunk lines
- `*** End of File` tries the match from the end first
- multiple hunks in one file are applied in order

If any hunk fails to verify, the whole patch is rejected and no file is changed.

## Alyce Safety Additions

Compared with opencode's implementation, Alyce keeps the existing file-tool safety model:

- existing files touched by Update, Delete, Move, or Add-overwrite require a full fresh `Read` first
- paths must stay inside the workspace or approved additional directories
- all affected paths are locked in deterministic order
- all files are preflighted before the approval prompt
- after approval, Alyce rechecks raw bytes before writing
- new destinations are written with exclusive create semantics to avoid approval-window races
- write-before snapshots are captured so `/rewind` can restore tracked changes
- if a write, delete, move, or post-write bookkeeping step throws after approval, Alyce best-effort rolls back paths that were already changed during that patch application
- text encoding and line endings are preserved for existing files
- configured formatters and TypeScript/JavaScript diagnostics run after successful writes

## Remaining Differences From opencode

The obvious editing gap is now closed: Alyce supports the opencode patch envelope, Add/Delete/Update/Move, multi-file patches, multi-hunk updates, insert-only hunks, heredoc wrappers, EOF anchors, context anchors, whitespace-tolerant matching, and Unicode punctuation matching.

The remaining differences are intentional safety/runtime differences:

- Alyce exposes `apply_patch` as a normal model tool with `{ "patchText": "..." }`; it does not intercept shell text as a hidden command.
- Add-overwrite and Move-overwrite are supported only when the existing destination has been fully read first.
- Diagnostics use Alyce's TypeScript/JavaScript diagnostic backend rather than opencode's LSP service.
