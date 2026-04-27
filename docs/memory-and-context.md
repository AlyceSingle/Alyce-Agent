<p align="center">
  English | <a href="./zh-CN/memory-and-context.md">简体中文</a>
</p>

# Memory and Context

Alyce speaking. *This is the part of the system I think about the most — probably more than is healthy. How does an assistant remember things without drowning itself in its own history?*

There are two problems that pull in opposite directions: you want the assistant to remember enough to be useful, but you also can't send the model an infinitely growing pile of text. Alyce-Agent tackles this with layers — different kinds of memory that serve different purposes, each with its own rules for what sticks and what fades.

## The Seven Layers of Context

When the model receives a turn, the context isn't a single blob. It's assembled from seven distinct pieces:

1. **System prompt** — the core instructions: identity, working style, safety rules, available tools.
2. **Live session messages** — the actual back-and-forth you've had this session.
3. **Restored session history** — if you used `/resume`, the old conversation gets loaded here.
4. **Session memory** — things you've told me with `/remember --session`. Dies when the session ends.
5. **Persistent memory** — things you've told me with `/remember`. Survives across sessions.
6. **Auto summary** — a periodically refreshed summary of recent work, injected automatically.
7. **Compaction summary** — when the conversation gets too long, old turns are compressed into this.

*The order matters. Later layers don't override earlier ones — they all coexist in the prompt, stacked one after another.*

## Session History

This is the "where was I" layer.

**Storage:** `./.alyce/sessions/<sessionId>.jsonl`

**Commands:**
- `/resume` — open the saved-sessions picker
- `/resume <id or search>` — jump straight to a specific session
- `/sessions` — list what's been saved
- `/rewind` — append a rewind marker so future resumes load the conversation after the rewind

**How it works:**
Every successful turn gets written as a JSONL line. When you resume, the entire message chain — what the model saw and what it said — gets restored. The visible terminal transcript comes back too. And new turns keep writing to the same file.

*Session history is not memory. It doesn't inject facts into unrelated conversations — it reopens a specific old conversation. Think of it like opening a saved document, not like adding a note to a notebook.*

## Session Memory

Short-lived, session-scoped notes.

**Source:** `/remember --session <text>`

**What happens:**
- It's injected into the prompt as a memory section.
- It only lives as long as the current session.
- `/clear` or `/memory clear` wipes it.

*Session memory is for things like "we're working on branch X" or "the test is currently failing for this reason." It's context you need right now but won't need tomorrow.*

## Persistent Memory

Long-lived, cross-session notes.

**Source:** `/remember <text>`

**Storage:** `./.alyce/memory/MEMORY.md` (by default, configurable via `AGENT_MEMORY_DIR` and `AGENT_MEMORY_FILE`).

**What happens:**
- Survives restarts, reboots, everything.
- Also injected into the prompt as a memory section.
- Persists until you explicitly clear it with `/memory clear --all`.

*Persistent memory is for reusable facts, user preferences, project knowledge. Things like "master prefers snake_case" or "this project's API keys are in a vault at X."*

## Auto Summary

The background note-taker.

**Triggers when** the conversation passes a threshold (configurable).

**What it does:**
- Doesn't update on every turn — that would be wasteful.
- Periodically compresses recent work into a reusable summary block.
- Helps the model keep track of what's been happening without rereading the whole conversation.

*Auto summary is like a progress report. It gives the model a sense of "here's what we've been doing" without making it reprocess every detail.*

## Conversation Compaction

The last line of defense against context overflow.

**Triggers when** the full message history approaches the model's context limit.

**After compaction:**
- The system prompt stays untouched.
- A structured compaction summary message is inserted.
- The most recent raw turns remain verbatim.
- Everything older is collapsed into summary form.

*The key insight: you don't need every word of a conversation from three hours ago. You need to know what was decided, what was tried, and what's still unresolved. Compaction preserves those signals while discarding the noise.*

## Timestamp Injection

If `messageTimestampsEnabled` is on, each API request includes a `# Current System Time` block with the local date and time. This is injected at request time only — it never leaks into your visible transcript and never pollutes the chat history.

*It's a small thing, but it means the model can ground its responses in real time instead of floating in a timeless void.*

## How to Peek at the Real Request

If you're ever unsure what the model is actually receiving — whether some memory is reaching it, whether compaction is active, whether a setting took effect — use:

```
/context
```

This shows the exact payload for the next turn after all runtime shaping is applied. *It's my favorite debugging command, and I use it constantly when something feels off.*

## When to Use What

| Need | Tool |
|---|---|
| A fact the assistant should know forever | `/remember` |
| A fact the assistant should know this session | `/remember --session` |
| Return to yesterday's conversation | `/resume` |
| See what the model will actually receive | `/context` |
| Check what's currently in memory | `/memory` |
| Clear temporary notes | `/memory clear` |
| Wipe everything and start fresh | `/memory clear --all` |

---

*I suppose the shortest way to say it is: Alyce tries to separate durable instructions from temporary conversation, and summary from transcript, so the context doesn't become a nervous, unmanageable pile of everything at once. It's not perfect, but it's better than the alternative — which is forgetting everything, or remembering everything and being unable to think.*
