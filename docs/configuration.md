<p align="center">
  English | <a href="./zh-CN/configuration.md">简体中文</a>
</p>

# Configuration

I am Alyce. This page provides a detailed explanation of Alyce's configuration system, including sources, priority, and the meaning of individual parameters.

Alyce's configuration is layered. Multiple sources can set the same value, and a specific priority order determines which value takes effect.

## Where Settings Come From

### Connection Config (API key, base URL, model)

Loaded in this priority order — **earlier wins over later**:

1. **CLI arguments** (passed when launching the app)
2. **Environment variables** (from your `.env` file)
3. **Project config** — `./.alyce/config.json`
4. **User config** — `~/.alyce/config.json`

### Session Settings (persona, memory, approval, etc.)

Loaded in this priority order — **again, earlier wins**:

1. **CLI arguments**
2. **Environment variables**
3. **Project settings** — `./.alyce/settings.json`
4. **User settings** — `~/.alyce/settings.json`

## File Map

| What | Where |
|---|---|
| Project connection config | `./.alyce/config.json` |
| User connection config | `~/.alyce/config.json` |
| Project session settings | `./.alyce/settings.json` |
| User session settings | `~/.alyce/settings.json` |
| Project MCP servers | `./.alyce/mcp.json` |
| Project skills | `./.alyce/skills/**/SKILL.md` |
| User skills | `~/.alyce/skills/**/SKILL.md` |
| MCP binary resource output | `./.alyce/mcp-output/` |

Do not commit `.env`, `./.alyce/`, `~/.alyce/`, or generated `dist/` output. Project settings can contain local paths, permission rules, memory, session history, MCP output, and sometimes credentials.

## Environment Variables

### Required (the app won't start without these)
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

### Optional (memory tuning, mostly)
- `AGENT_ADDITIONAL_DIRECTORIES` — extra paths separated by the system path delimiter (`;` on Windows, `:` on Linux/macOS)
- `AGENT_MEMORY_DIR` — override memory storage directory
- `AGENT_MEMORY_FILE` — override memory file name
- `AGENT_SESSION_MEMORY_FILE` — override the auto-managed session memory file name, default `SESSION_MEMORY.md`
- `AGENT_SESSION_MEMORY_ENABLED` — enable/disable automatic session memory extraction, default `true`
- `AGENT_SESSION_MEMORY_INIT_TOKENS` — estimated context tokens before session memory initializes, default `10000`
- `AGENT_SESSION_MEMORY_UPDATE_TOKENS` — estimated token growth required between session memory updates, default `5000`
- `AGENT_SESSION_MEMORY_TOOL_CALLS` — tool calls required between updates when the last assistant turn still has tool calls, default `3`
- `AGENT_SESSION_MEMORY_TIMEOUT_MS` — timeout for the background session memory model call, default `180000`
- `AGENT_SESSION_MEMORY_MAX_FAILURES` — consecutive background session memory failures before circuit breaking, default `3`
- `AGENT_SESSION_MEMORY_STALE_MS` — age after which an in-flight extraction is considered stale, default `60000`
- `AGENT_SESSION_MEMORY_WINDOW_MESSAGES` — max recent messages included in a session memory extraction request, default `80`
- `AGENT_SESSION_MEMORY_MAX_CHARS_PER_MESSAGE` — per-message truncation for extraction prompts, default `1500`
- `AGENT_MEMORY_MAX_SESSION` — max session memory entries
- `AGENT_MEMORY_MAX_PERSISTENT` — max persistent memory entries
- `AGENT_MEMORY_MAX_PROMPT` — max memory chars injected into prompt
- `AGENT_MARKDOWN_TOOL_RENDERING_ENABLED` — enable/disable markdown rendering for eligible tool-result messages, default `true`
- `AGENT_MARKDOWN_RENDER_MAX_CHARS` — markdown render character budget before fallback, default `32000`
- `AGENT_SCROLL_SPEED` — base line-scroll rows for transcript navigation, default `2` (clamped to `1-8`)
- `AGENT_SCROLL_ACCELERATION_ENABLED` — enable/disable short-burst line-scroll acceleration, default `false`
- `AGENT_MAX_MESSAGES_WITHOUT_VIRTUALIZATION` — safety cap for non-virtual transcript mode, default `200`
- `AGENT_HISTORY_PAGING_ENABLED` — experimental resumed-session history paging (load recent first, prepend older chunks near top), default `false`
- `AGENT_AUTO_COMPACT_TIMEOUT_MS` — timeout for automatic compaction model calls, default `180000`
- `AGENT_AUTO_COMPACT_MAX_FAILURES` — consecutive automatic compaction failures before circuit breaking, default `3`
- `AGENT_MODEL_CONTEXT_WINDOW_OVERRIDES` — comma-separated model context overrides, for example `custom fast=512000,my alias=1000000`

Compatibility note: `AGENT_MEMORY_AUTO_SUMMARY` is still accepted as an alias for `AGENT_SESSION_MEMORY_ENABLED`, but the old message-count summary variables are retired.

`permissionRules` are configured in `./.alyce/settings.json` or `~/.alyce/settings.json`, not through environment variables. This keeps persistent trust decisions reviewable in JSON instead of hiding them in shell startup files.

### Optional Web Search Settings

- `ALYCE_WEB_SEARCH_PROVIDER` — `auto`, `brave`, `exa`, or `duckduckgo`. `auto` tries Brave Search first when a key is set, then Exa MCP, then DuckDuckGo HTML.
- `WEB_SEARCH_PROVIDER` — legacy alias for `ALYCE_WEB_SEARCH_PROVIDER`.
- `ALYCE_BRAVE_SEARCH_API_KEY` — optional Brave Search API key.
- `BRAVE_SEARCH_API_KEY` — legacy alias for `ALYCE_BRAVE_SEARCH_API_KEY`.
- `ALYCE_WEB_SEARCH_CACHE_TTL_MS` — in-memory web search provider-result cache TTL in milliseconds. Set `0` to disable.
- `WEB_SEARCH_CACHE_TTL_MS` — legacy alias for `ALYCE_WEB_SEARCH_CACHE_TTL_MS`.
- `ALYCE_WEB_SEARCH_USER_AGENT` — optional browser-compatible user agent override for DuckDuckGo fallback requests.
- `ALYCE_WEB_SEARCH_HONEST_USER_AGENT` — optional transparent user agent override used for Exa MCP and DuckDuckGo challenge fallback.
- `ALYCE_WEB_SEARCH_ACCEPT_LANGUAGE` — optional `Accept-Language` header for web search requests.

DuckDuckGo HTML is kept as a no-key fallback, but it can still be blocked or rate-limited by search-engine anti-bot systems. Use the default `auto` provider when possible.

### Optional Web Fetch Settings

- `ALYCE_WEB_FETCH_MAX_BYTES` — maximum bytes `WebFetch` will download from a single response. Defaults to `5242880`.
- `WEB_FETCH_MAX_BYTES` — legacy alias for `ALYCE_WEB_FETCH_MAX_BYTES`.
- `ALYCE_WEB_FETCH_CACHE_TTL_MS` — in-memory successful fetch cache TTL in milliseconds. Set `0` to disable.
- `WEB_FETCH_CACHE_TTL_MS` — legacy alias for `ALYCE_WEB_FETCH_CACHE_TTL_MS`.
- `ALYCE_WEB_FETCH_CACHE_MAX_BYTES` — total in-memory successful fetch cache budget in bytes. Defaults to `33554432`; set `0` to disable fetch caching.
- `WEB_FETCH_CACHE_MAX_BYTES` — legacy alias for `ALYCE_WEB_FETCH_CACHE_MAX_BYTES`.
- `ALYCE_WEB_FETCH_USER_AGENT` — optional browser-compatible user agent override for `WebFetch`.
- `ALYCE_WEB_FETCH_HONEST_USER_AGENT` — optional transparent user agent override used for Wikimedia-like sites and challenge fallback. Include a contact URL for sites that require one.
- `ALYCE_WEB_FETCH_ACCEPT_LANGUAGE` — optional `Accept-Language` header for `WebFetch`.

## Skills

Alyce discovers local skills from:

- Project skills: `./.alyce/skills/**/SKILL.md`
- User skills: `~/.alyce/skills/**/SKILL.md`

Use `SkillTool` with the skill name to load a skill. Project skills override user skills with the same normalized name. A skill file may include simple frontmatter:

```markdown
---
name: example
description: Use this workflow for repeated project tasks.
---

# Example Skill

Follow these instructions when this skill is loaded.
```

The loaded skill content is attached as generated context for the next model step. Loading a skill requires tool approval.

## MCP Servers

Project MCP servers are configured in `./.alyce/mcp.json`. Alyce supports local stdio servers plus remote streamable HTTP or SSE servers. MCP calls and resource reads require approval.

### Local stdio server

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "startup_timeout_ms": 20000
    }
  }
}
```

After startup, Alyce exposes:

- `McpStatus` — show configured servers, transport, endpoint, capabilities, and errors.
- `ListMcpResources` — list MCP resources, optionally filtered by server.
- `ReadMcpResource` — read text resources inline; write blob resources to `./.alyce/mcp-output/`.
- Dynamic MCP tools as `mcp__server__tool` when a server exposes tools.

### Remote streamable HTTP server

```json
{
  "mcpServers": {
    "remote-example": {
      "type": "streamable_http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      },
      "startup_timeout_ms": 20000
    }
  }
}
```

### Remote SSE server

```json
{
  "mcpServers": {
    "legacy-sse": {
      "type": "sse",
      "url": "https://example.com/sse",
      "startup_timeout_ms": 20000
    }
  }
}
```

If a server fails, Alyce reports that server's error without disabling other configured MCP servers.

## Connection Fields

These appear in the **Connection** tab of settings:

- `apiKey` — your OpenAI-compatible API key
- `baseURL` — the endpoint URL
- `model` — model identifier string

You can save these to **user scope** (global on your machine) or **project scope** (lives with this project). Press `P` in the Connection tab to switch.

## Session Settings

These appear in the **Session** tab of settings.

### Execution & Approval

- `approvalMode` — how strict tool approval is. Options range from always-ask to smart-defaults.
- `maxSteps` — maximum tool-calling steps per turn before the agent must produce a final answer.
- `commandTimeoutMs` — timeout for shell commands in milliseconds.
- `scrollSpeed` — base number of rows used for line-by-line transcript scroll actions (`1-8`).
- `scrollAccelerationEnabled` — when enabled, repeated line-scroll actions in a short window accelerate progressively.
- `maxMessagesWithoutVirtualization` — non-virtual transcript safety cap that prevents fallback mode from growing without bound.
- `historyPagingEnabled` — experimental setting that resumes long sessions with a recent window first and lazily prepends older transcript chunks near the top.

### Permission Rules

`permissionRules` is an optional array in session settings. Rules can live in project settings or user settings:

```json
{
  "approvalMode": "manual",
  "permissionRules": [
    {
      "permission": "shell",
      "pattern": "npm run build",
      "action": "allow",
      "scope": "persistent",
      "reason": "Known local validation command."
    },
    {
      "permission": "file.read",
      "pattern": "sensitive:*",
      "action": "ask",
      "reason": "Review secret-like files before reading."
    }
  ]
}
```

Supported `permission` values are:

```text
*
shell
powershell
file.read
file.write
file.edit
file.patch
directory.external
web.fetch
web.search
mcp.tool
mcp.resource
skill.load
task.spawn
```

Supported `action` values are `allow`, `ask`, and `deny`. `pattern` defaults to `*` when omitted. A few common pattern forms are:

- `workspace:src/index.ts` for workspace-relative file paths.
- `workspace:*` for any workspace path.
- `external:C:\Some\Path` or an absolute external path pattern for outside directories.
- `sensitive:*` for `.env`, `.alyce`, private keys, credential files, and similar paths.
- exact shell/PowerShell command text such as `npm run build`.
- URL or MCP patterns such as `https://docs.example.com/*` or `*`.

Rule precedence is source-aware: built-in defaults are lowest, then project settings, then user settings, then approvals made during the current session, then the Plan Mode overlay. When multiple rules match, stricter actions win, so `deny` beats `allow`, and `allow` beats `ask` only when no stricter matching rule applies. Some requests set `forceAsk`; sensitive/generated file paths and high-risk commands still prompt even if a broad session allow rule exists.

The approval dialog can also create temporary session rules:

- **Allow once** approves only the current request.
- **Allow this kind for session** allows ordinary requests of the same permission kind until restart.
- **Allow directory for session** allows the requested external directory until restart.
- **Auto approve this session** allows ordinary requests until restart. High-risk `forceAsk` requests can still ask.

### Plan Mode

Use `/plan` to enter Plan Mode and `/plan exit` or `/build` to leave it. This is a runtime mode, not a persisted setting.

While active, Alyce adds a high-priority Plan Mode permission overlay:

- workspace reads are allowed for exploration.
- external directory reads/searches still require approval.
- file writes, edits, patches, arbitrary MCP tools, skill loading, and subagent spawning are denied.
- web fetch/search and MCP resource listing/reading are allowed.
- shell and PowerShell commands are approval-gated and must be classified as read-only inspection commands.

Plan Mode also removes mutating tool schemas from the model-facing tool list where possible. A second enforcement layer still runs at tool execution time, so blocked tools return a Plan Mode violation instead of silently executing.

### Doctor Checks

`/doctor` runs local diagnostics and prints a report into the conversation. It checks:

- Node version (`>=20.10.0`).
- interactive stdin/stdout TTY.
- workspace readability.
- project files (`package.json`, `src/index.ts`, and `dist/index.js`).
- API key, base URL, and model configuration.
- runtime settings and approval risk.
- MCP config parseability.
- project and user skill discovery.
- `rg` and `git` availability.
- `.alyce` storage writability.
- active request patch overrides.

Use `/doctor` when startup succeeds but tool behavior, config, or local environment state feels wrong.

### Prompt & Persona

- `languagePreference` — which language the assistant should respond in.
- `personaPreset` — which built-in persona to use. Options: `None`, `alyce`, `lilith`, `corin`. *See the [Persona Presets](persona-presets.md) page for details.*
- `aiPersonalityPrompt` — custom personality instructions layered on top of (or instead of) the persona preset.
- `appendSystemPrompt` — extra text appended directly to the system prompt. Use sparingly.

### Memory & Context

- `sessionMemoryEnabled` — whether the session memory file is injected and automatically maintained. Older `autoSummaryEnabled` settings files are read as a compatibility alias.
- `messageTimestampsEnabled` — whether the model sees the current system time in each turn.
- `markdownMessageRenderingEnabled` — global markdown rendering switch for conversation messages.
- `markdownToolMessageRenderingEnabled` — fine-grained switch for markdown rendering on eligible tool-result messages.
- `markdownRenderMaxChars` — markdown render character budget. Messages exceeding this budget fall back to plain/code sections.
- `conversationCompactionEnabled` — whether long conversations get compressed to stay within context limits.
- `autoCompactTimeoutMs` — timeout for automatic compaction model calls.
- `autoCompactMaxFailures` — consecutive automatic compaction failures before Alyce stops retrying for the current session.
- Session memory extraction uses threshold-based triggers: initialize after `AGENT_SESSION_MEMORY_INIT_TOKENS`, then update only after `AGENT_SESSION_MEMORY_UPDATE_TOKENS` of estimated context growth and either enough tool calls or a natural assistant break. The updater runs in the background with timeout, stale-task cancellation, and a circuit breaker.
- `modelContextWindowOverrides` — optional context window overrides for custom model aliases or proxy-specific model names. Use loose model patterns as keys and token counts as values, for example:

```json
{
  "modelContextWindowOverrides": {
    "company gemini pro": 1048576,
    "custom fast": 512000
  }
}
```

Alyce first checks these overrides, then explicit suffixes in the model name such as `128k` or `1m`, then its built-in provider table. Unknown models fall back to `128000` tokens.

### Markdown Rendering Rules

- Assistant/thinking messages can render as markdown when `markdownMessageRenderingEnabled` is on.
- Tool messages require both `markdownMessageRenderingEnabled` and `markdownToolMessageRenderingEnabled`.
- `shell` / `write` / `edit` / `patch` tool results always stay code/diff-first.
- Markdown-capable tool rendering is limited to text-heavy tool results (for example list/glob/grep/webfetch/websearch/codesearch style outputs) and keeps collapsed previews in section mode.
- If markdown parsing hits safety budgets (size/line/nesting limits) or parsing fails, Alyce automatically falls back to plain/code sections.

### Markdown Limitations in TTY

- Alyce uses terminal-native markdown rendering, not browser DOM rendering.
- Emphasis, links, tables, quotes, and math use terminal-native styles/spans; fenced code blocks remain plain code blocks without language syntax highlighting.
- Inline `$...$` and display `$$...$$` math are rendered as readable Unicode/plain text, not KaTeX HTML.
- DOM-level HTML behaviors (sanitizers, layout engines, CSS, script execution) are intentionally unsupported.
- Table, quote, and link semantics are approximated for terminal readability.
- Copy behavior follows rendered terminal text; for labeled links, Alyce appends `<URL>` so copied text preserves the target.

### Paths

- `additionalDirectories` — extra directories the agent is allowed to access beyond the workspace root. Read/search tools can also request external directory access on demand for the current session without saving it here.

## Two Settings Worth Understanding

### `messageTimestampsEnabled`

When turned on, each API request includes a small `# Current System Time` block with the local date and time. This is injected at request time — it doesn't appear in your visible transcript and doesn't get mixed into the chat history.

### `conversationCompactionEnabled`

When turned on, Alyce compacts older conversation only when the estimated request is close to the model context limit. Recent raw turns stay untouched; older turns get rewritten into a structured summary. Automatic compaction has a timeout and a circuit breaker, so repeated failures stop further automatic attempts for the current session instead of blocking every turn.

---

If a setting is not behaving as expected, `/context` will show what the model is actually receiving, which is often the fastest way to diagnose configuration issues.
