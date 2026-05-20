# Skill / MCP P0 Compatibility Notes

Date: 2026-05-19

This note captures the compatibility baseline protected by the P0 regression tests for Alyce's current Skill and MCP behavior.

## Skill compatibility baseline

- Alyce continues to discover skills from project `.alyce/skills/**/SKILL.md`.
- Alyce continues to discover skills from user `~/.alyce/skills/**/SKILL.md`.
- `SKILL.md` files without YAML frontmatter are still valid:
  - The skill name falls back to the containing directory name.
  - The description falls back to the first useful body line.
- When project and user skills share the same normalized name, the project skill continues to win.
- Skill discovery continues to ignore unreadable or malformed local skill files instead of failing the whole scan.

## MCP compatibility baseline

- Alyce continues to treat project `.alyce/mcp.json` as the active MCP config source.
- Missing `.alyce/mcp.json` continues to mean "no MCP servers configured", not a runtime error.
- Alyce continues to accept these currently supported transports:
  - `stdio`
  - `sse`
  - `streamable_http`
- Invalid MCP JSON continues to surface as a configuration error in the runtime status.
- Invalid MCP config schema continues to fail validation with a path-specific error message.
- MCP runtime initialization continues to time out instead of hanging indefinitely when a server does not list tools in time.

## P0 validation coverage

The P0 regression tests now explicitly cover:

- Skill discovery from project and user roots.
- Frontmatter-free skill fallback behavior.
- Project-over-user skill shadowing.
- Missing MCP config handling.
- `stdio`, `sse`, and `streamable_http` config parsing.
- Invalid MCP config JSON and invalid schema handling.
- MCP runtime timeout, abort, retry, and resource read/list behavior.
