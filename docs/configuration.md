<p align="center">
  English | <a href="./zh-CN/configuration.md">简体中文</a>
</p>

# Configuration

Alyce speaking. The configuration system is layered on purpose. I would rather describe it plainly than leave you guessing which file wins.

## Configuration Sources

### Connection Config

Loaded from:

- environment variables
- `~/.alyce/config.json`
- `./.alyce/config.json`
- CLI arguments

### Session Settings

Loaded from:

- `./.alyce/settings.json`
- `~/.alyce/settings.json`
- environment variables
- CLI arguments

## File Locations

- project connection config: `./.alyce/config.json`
- user connection config: `~/.alyce/config.json`
- project session settings: `./.alyce/settings.json`
- user session settings: `~/.alyce/settings.json`

## Environment Variables

### Required

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

### Optional

- `AGENT_ADDITIONAL_DIRECTORIES`
- `AGENT_MEMORY_DIR`
- `AGENT_MEMORY_FILE`
- `AGENT_MEMORY_MAX_SESSION`
- `AGENT_MEMORY_MAX_PERSISTENT`
- `AGENT_MEMORY_MAX_PROMPT`
- `AGENT_MEMORY_AUTO_SUMMARY`
- `AGENT_MEMORY_SUMMARY_MIN_MESSAGES`
- `AGENT_MEMORY_SUMMARY_INTERVAL_MESSAGES`
- `AGENT_MEMORY_SUMMARY_WINDOW_MESSAGES`
- `AGENT_MEMORY_SUMMARY_MAX_CHARS_PER_MESSAGE`

## Connection Fields

- `apiKey`
- `baseURL`
- `model`

Connection config can be saved to:

- user scope
- project scope

The settings dialog lets you switch the target with `P`.

## Session Settings

### Execution and Approval

- `approvalMode`
- `maxSteps`
- `commandTimeoutMs`

### Prompt and Persona

- `languagePreference`
- `personaPreset`
- `aiPersonalityPrompt`
- `appendSystemPrompt`

### Memory and Context

- `autoSummaryEnabled`
- `messageTimestampsEnabled`
- `conversationCompactionEnabled`

### Paths and Startup Documents

- `additionalDirectories`
- `startupInstructionFiles`

## `startupInstructionFiles`

This field loads text documents automatically:

- at session start
- after settings changes
- after `/clear`

They are injected as a dedicated prompt section, not stored as normal memory.

Good candidates:

- project rules
- persona sheets
- long-lived workflow instructions
- stable background reference notes

## `messageTimestampsEnabled`

When enabled:

- user messages carry their submission time
- assistant messages carry their generation time
- the current reply also receives the current local system time

These timestamps are injected at API request time, not shown directly in the visible transcript.

## `conversationCompactionEnabled`

When enabled:

- long conversations are compacted after a threshold
- recent raw turns stay visible
- older turns are rewritten into a structured summary message

This is mainly there to keep context growth bounded.
