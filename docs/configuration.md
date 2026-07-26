<p align="center">
  English | <a href="./zh-CN/configuration.md">简体中文</a>
</p>

# Configuration

I am Alyce. This page provides a detailed explanation of Alyce's configuration system, including sources, priority, and the meaning of individual parameters.

Alyce's configuration is layered. Multiple sources can set the same value, and a specific priority order determines which value takes effect.

## Where Settings Come From

### Connection Config (API key, base URL, model, providers)

Loaded in this priority order — **earlier wins over later**:

1. **CLI arguments** (passed when launching the app)
2. **User config** — `~/.alyce/config.json`
3. **Project config** — `./.alyce/config.json`
4. **Environment variables** (legacy `OPENAI_*` startup defaults)

### Session Settings (persona, memory, approval, etc.)

Loaded in this priority order — **again, earlier wins**:

1. **CLI arguments**
2. **Environment variables**
3. **User settings** — `~/.alyce/settings.json`
4. **Project settings** — `./.alyce/settings.json`

## File Map

| What | Where |
|---|---|
| Project connection config | `./.alyce/config.json` |
| User connection config | `~/.alyce/config.json` |
| User provider credentials | `~/.alyce/auth.json` |
| User provider plugins | `~/.alyce/plugins/*/.alyce-plugin.json` |
| Project provider plugins | `./.alyce/plugins/*/.alyce-plugin.json` (disabled by default) |
| Project session settings | `./.alyce/settings.json` |
| User session settings | `~/.alyce/settings.json` |
| Project MCP servers | `./.alyce/mcp.json` |
| Project skills | `./.alyce/skills/**/SKILL.md` |
| User skills | `~/.alyce/skills/**/SKILL.md` |
| MCP binary resource output | `./.alyce/mcp-output/` |

Do not commit `.env`, `./.alyce/`, `~/.alyce/`, or generated `dist/` output. Project settings can contain local paths, permission rules, memory, session history, and MCP output. Real provider tokens should live in `~/.alyce/auth.json` or an environment variable, not in project config.

## Environment Variables

## Startup Context CLI Flags

Alyce can start with explicit editor context without installing a VS Code extension:

- `--cwd <path>` — choose the workspace root before config and path checks run.
- `--context-file <path>` — read one file and inject it as generated context for the next model turn. May be repeated.
- `--selection-file <path>` — read a file containing selected editor text and inject it as generated context for the next model turn. May be repeated.
- `--initial-prompt <text>` — prefill the input box. Alyce does not auto-send it.
- `--prompt-file <path>` — read the prefilled input text from a file. Cannot be combined with `--initial-prompt`.

All startup file paths are resolved under the same allowed-root rules as file tools. A file outside the workspace is rejected unless the directory is already configured in `additionalDirectories`. Missing files fail startup with a clear error. Startup context is not a broad workspace read, does not grant write approval, and is removed from the live message list after the first model turn like other generated context.

### Legacy OpenAI-compatible startup defaults
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

Saved connection config still overrides these startup defaults. The old inline `apiKey` shape remains readable for compatibility, but prefer `OPENAI_API_KEY`, `/connect`, or provider `apiKeyEnv` for real tokens.

```json
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-5.2"
}
```

### AuthStore and `/connect`

Use `/connect` to save common provider credentials without editing `.env`. With no arguments, `/connect` opens an interactive provider picker and masked credential form. Built-in presets currently include OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Kimi, Qwen/DashScope, SiliconFlow, Doubao/Volcengine Ark, generic local, Ollama, and LM Studio.

Advanced/scriptable forms are also available:

```text
/connect <provider> <api-key> [model] [baseURL]
/connect <local-provider> [baseURL] [model]
/connect custom <provider-id> <baseURL> <model> <api-key> [label]
```

API-key presets: `openai`, `anthropic`, `google`, `openrouter`, `deepseek`, `kimi`, `qwen`, `siliconflow`, `doubao`.

Local presets: `local`, `ollama`, `lmstudio`.

API keys saved by `/connect` are written to `~/.alyce/auth.json`. The selected model is saved in user connection config, and custom/local provider profiles are saved without `apiKey`. `/logout <provider>` removes the AuthStore credential but leaves provider profiles and selected model unchanged.

Provider profiles can be stored in `./.alyce/config.json` or `~/.alyce/config.json` under `providers`. Model references use `provider/model`; a bare `/model gpt-5.2` keeps using the current provider.

```json
{
  "model": "openrouter/openai/gpt-5.2",
  "providers": {
    "openrouter": {
      "label": "OpenRouter",
      "kind": "openrouter",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "baseURL": "https://openrouter.ai/api/v1",
      "defaultModel": "openai/gpt-5.2",
      "models": {
        "openai/gpt-5.2": {
          "contextWindow": 400000
        },
        "anthropic/claude-sonnet-4.6": {
          "contextWindow": 1000000
        }
      }
    },
    "local": {
      "label": "Local",
      "kind": "local",
      "baseURL": "http://127.0.0.1:11434/v1",
      "defaultModel": "qwen",
      "models": {
        "qwen": {
          "contextWindow": 256000
        }
      }
    }
  }
}
```

Use `/model` or `/models` to refresh the current provider's model list and open its model picker, or `/model list` to see the current provider/model, provider auth status, provider availability, known models, and switch examples. OpenAI-compatible providers continue through the shared compatible adapter. Anthropic and Google use native adapters when no compatible `baseURL` is configured, and fall back to the compatible adapter when a `baseURL` is present.

Built-in preset defaults:

| Provider | `apiKeyEnv` | Base URL | Default model |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | native Messages API | `claude-sonnet-4.6` |
| `google` | `GOOGLE_API_KEY` | native Gemini API | `gemini-3-flash` |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `openai/gpt-5.2` |
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `kimi` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | `kimi-k2.6` |
| `qwen` | `DASHSCOPE_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `siliconflow` | `SILICONFLOW_API_KEY` | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| `doubao` | `ARK_API_KEY` | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-250615` |
| `local` | not required | configured during `/connect` | `local-model` |
| `ollama` | not required | `http://127.0.0.1:11434/v1` | `llama3.1` |
| `lmstudio` | not required | `http://localhost:1234/v1` | `local-model` |

Optional model price metadata can be added per model with `inputCostPerMillionTokens` and `outputCostPerMillionTokens`. `/usage` uses these values for estimated cost; models without both values are shown as tokens only.

Per-model sampling and reasoning options:

- `temperature`: sampling temperature (`0`–`2`) used when Alyce does not pass an explicit one. Set it to `null` to omit the parameter entirely for models that reject it. Alyce also omits `temperature` automatically for known reasoning model families (`o1`/`o3`/`o4`-style and `gpt-5`-style ids).
- `reasoningEffort`: `"minimal" | "low" | "medium" | "high"`. Sent as `reasoning_effort` on OpenAI-compatible channels; setting it also stops `temperature` from being sent.
- `thinkingBudgetTokens`: enables extended thinking with this token budget on the native Anthropic channel (`thinking.budget_tokens`; `max_tokens` is raised above the budget automatically) and on the native Gemini channel (`generationConfig.thinkingConfig`). Thinking output streams into the collapsible thinking view.

```json
"models": {
  "o3-mini": { "reasoningEffort": "high" },
  "claude-sonnet-4.6": { "thinkingBudgetTokens": 8000 },
  "gpt-4.1": { "temperature": 0.7 }
}
```

### Experimental Connectors and Provider Plugins

GitHub Copilot and Codex / ChatGPT account connectors are visible in `/connect`, but still marked experimental. They use local browser/device OAuth-style flows and store tokens only in `~/.alyce/auth.json`. They do not require an Alyce server, public callback domain, or certificate. They are intentionally isolated from stable API-key providers because these account flows can break when upstream platforms change.

Alyce also has a JSON-only provider plugin boundary:

- User plugins load from `~/.alyce/plugins/*/.alyce-plugin.json`.
- Project plugins are scanned from `./.alyce/plugins/*/.alyce-plugin.json` but skipped unless `ALYCE_ENABLE_PROJECT_PROVIDER_PLUGINS=true`.
- Plugin manifests can declare provider profiles and API-key or well-known auth prompts. They cannot execute shell commands by default.
- Invalid plugin manifests are reported by `/doctor` and do not block startup.

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
- `AGENT_SNAPSHOT_ENABLED` — enable/disable Alyce file snapshots, default `true`
- `AGENT_SNAPSHOT_ENGINE` — `hybrid`, `git-tree`, or `file-backup`, default `hybrid`
- `AGENT_SNAPSHOT_MAX_TEXT_DIFF_BYTES` — configured text diff budget for snapshot diagnostics, default `524288`
- `AGENT_SNAPSHOT_MAX_FILE_BYTES` — configured per-file snapshot budget, default `2097152`
- `AGENT_SNAPSHOT_RETENTION_DAYS` — days to retain snapshot/file-history storage before startup cleanup, default `7`
- `AGENT_SNAPSHOT_INCLUDE_IGNORED_EXPLICIT_PATHS` — keep explicit ignored-path file-history overlays enabled, default `true`
- `AGENT_SNAPSHOT_MANIFEST_SCAN` — capture directory manifests for empty-directory rewind, default `true`

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

### Optional Search Tool Settings

- `ALYCE_RIPGREP_MAX_OUTPUT_BYTES` — maximum bytes of raw ripgrep output buffered by `Grep` and `Glob` before truncation. Defaults to `20971520` (20 MB). Truncated searches report `outputTruncated` so the agent can narrow the query.

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

## Session Settings

These appear in the **Session** tab of settings.

### Execution & Approval

- `approvalMode` — access and approval mode. Supported values are `read-only`, `default`, `auto-review`, and `full-access`.
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
  "approvalMode": "default",
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

Rule precedence is source-aware: built-in defaults are lowest, then project settings, then user settings, then approvals made during the current session, then the Plan Mode overlay. When multiple rules match, stricter actions win, so `deny` beats `allow`, and `allow` beats `ask` only when no stricter matching rule applies. Some requests set `forceAsk`; sensitive/generated file paths and high-risk commands still prompt unless `approvalMode` is `full-access`.

The built-in approval modes are:

- `read-only` — workspace reads are allowed; writes, commands, network, and external directories ask.
- `default` — workspace reads/writes and ordinary commands are allowed; network, external directories, and `forceAsk` requests ask.
- `auto-review` — same baseline as `default`, but eligible ordinary prompts are reviewed by the internal `auto-reviewer` subagent before falling back to manual approval.
- `full-access` — all permission requests are allowed without prompting, including `forceAsk` requests.

The approval dialog can also create temporary session rules:

- **Allow once** approves only the current request.
- **Allow this kind for session** allows ordinary requests of the same permission kind until restart.
- **Allow directory for session** allows the requested external directory until restart.
- **Switch to Full Access** saves `approvalMode: "full-access"` and approves the current request.

Use `/permissions` to switch among the four approval modes without opening the full settings panel.

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
- snapshot engine status, snapshot directory paths, retention, git-tree availability, and recent snapshot/cleanup errors.
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

### Diff/Rewind Snapshots

`snapshot` in `./.alyce/settings.json` or `~/.alyce/settings.json` controls the file snapshot foundation used by `/diff`, `/revert`, and code rewind:

```json
{
  "snapshot": {
    "enabled": true,
    "engine": "hybrid",
    "maxTextDiffBytes": 524288,
    "maxFileBytes": 2097152,
    "retentionDays": 7,
    "includeIgnoredExplicitPaths": true,
    "manifestScan": true
  }
}
```

- `engine: "hybrid"` uses git-tree turn snapshots plus file-history overlays for explicit ignored/external paths.
- `engine: "git-tree"` uses workspace-level git-tree snapshots only.
- `engine: "file-backup"` uses explicit file-history overlays only.
- `manifestScan` controls directory manifest capture for empty-directory rewind.
- `retentionDays` is applied at startup to stale `.alyce/snapshots/git/` and `.alyce/file-history/` directories; the current workspace git-tree store is not removed during startup cleanup.
- `/doctor` reports the active engine, git availability, snapshot storage paths, retention, and the latest snapshot or cleanup error.

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
