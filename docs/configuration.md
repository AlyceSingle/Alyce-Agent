<p align="center">
  English | <a href="./zh-CN/configuration.md">简体中文</a>
</p>

# Configuration

Alyce speaking. *Configuration systems are the kind of thing that seem simple until you realize there are four places a setting could come from and you don't know which one wins. So let me be boring but clear.*

Alyce's configuration is layered. Multiple sources can set the same value, and there's a specific order that decides who wins. Once you know the order, it's painless.

## Where Settings Come From

### Connection Config (API key, base URL, model)

Loaded in this priority order — **earlier wins over later**:

1. **CLI arguments** (passed when launching the app)
2. **Environment variables** (from your `.env` file)
3. **Project config** — `./.alyce/config.json`
4. **User config** — `~/.alyce/config.json`

*In practice, environment variables usually win because `.env` gets loaded first and most people don't pass CLI arguments. But if you set something in the settings dialog and save it to project scope, that'll take effect next time.*

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

*The `./` versions are per-project — they travel with the repo (if you commit `.alyce/`, which you shouldn't). The `~/` versions are global to your machine. Use project scope for project-specific stuff, user scope for personal defaults.*

## Environment Variables

### Required (the app won't start without these)
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

### Optional (memory tuning, mostly)
- `AGENT_ADDITIONAL_DIRECTORIES` — comma-separated extra paths
- `AGENT_MEMORY_DIR` — override memory storage directory
- `AGENT_MEMORY_FILE` — override memory file name
- `AGENT_MEMORY_MAX_SESSION` — max session memory entries
- `AGENT_MEMORY_MAX_PERSISTENT` — max persistent memory entries
- `AGENT_MEMORY_MAX_PROMPT` — max memory chars injected into prompt
- `AGENT_MEMORY_AUTO_SUMMARY` — enable/disable auto summary
- `AGENT_MEMORY_SUMMARY_MIN_MESSAGES` — messages before summary starts
- `AGENT_MEMORY_SUMMARY_INTERVAL_MESSAGES` — how often summary updates
- `AGENT_MEMORY_SUMMARY_WINDOW_MESSAGES` — how many messages per summary
- `AGENT_MEMORY_SUMMARY_MAX_CHARS_PER_MESSAGE` — truncation per message

*Most users never touch the optional ones. They're there for when you have a strong opinion about memory behavior or you're running in an unusual environment.*

## Connection Fields

These appear in the **Connection** tab of settings:

- `apiKey` — your OpenAI-compatible API key
- `baseURL` — the endpoint URL
- `model` — model identifier string

You can save these to **user scope** (global on your machine) or **project scope** (lives with this project). Press `P` in the Connection tab to switch.

*I'd recommend user scope for API keys — it keeps them out of the project directory entirely.*

## Session Settings

These appear in the **Session** tab of settings.

### Execution & Approval

- `approvalMode` — how strict tool approval is. Options range from always-ask to smart-defaults.
- `maxSteps` — maximum tool-calling steps per turn before the agent must produce a final answer.
- `commandTimeoutMs` — timeout for shell commands in milliseconds.

### Prompt & Persona

- `languagePreference` — which language the assistant should respond in.
- `personaPreset` — which built-in persona to use. Options: `None`, `alyce`, `lilith`, `corin`. *See the [Persona Presets](persona-presets.md) page for details.*
- `aiPersonalityPrompt` — custom personality instructions layered on top of (or instead of) the persona preset.
- `appendSystemPrompt` — extra text appended directly to the system prompt. Use sparingly.

### Memory & Context

- `autoSummaryEnabled` — whether auto-summarization of recent work is active.
- `messageTimestampsEnabled` — whether the model sees the current system time in each turn.
- `conversationCompactionEnabled` — whether long conversations get compressed to stay within context limits.

### Paths

- `additionalDirectories` — extra directories the agent is allowed to access beyond the workspace root.

## Two Settings Worth Understanding

### `messageTimestampsEnabled`

When turned on, each API request includes a small `# Current System Time` block with the local date and time. This is injected at request time — it doesn't appear in your visible transcript and doesn't get mixed into the chat history. *I find it useful because the model can then say things like "as of this morning" instead of always being vague about time.*

### `conversationCompactionEnabled`

When turned on, long conversations get compacted after they cross a threshold. Recent raw turns stay untouched; older turns get rewritten into a structured summary. The goal isn't to delete anything — it's to keep the useful information present without dragging the full transcript forward forever. *Without this, sessions that run for hours would eventually overflow the model's context window and start losing the beginning of the conversation.*

---

*That's the configuration layer. If a setting isn't behaving the way you expect, `/context` will show you what the model is actually receiving — it's usually the fastest way to spot a config problem.*
