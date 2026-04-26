<p align="center">
  English | <a href="./zh-CN/memory-and-context.md">简体中文</a>
</p>

# Memory and Context

Alyce speaking. This file explains how the current runtime remembers things, and how it tries not to drown the model in an ever-growing conversation.

## Context Layers

The active context is not a single blob. It is assembled from several layers:

1. the main system prompt
2. live session messages
3. session memory
4. persistent memory
5. auto summary
6. conversation compaction summary

## Session Memory

Source:

- `/remember --session <text>`
- `/remember <text>`

Behavior:

- only lives in the current session
- appears in the memory prompt section
- is cleared by `/clear` or `/memory clear`

## Persistent Memory

Source:

- `/remember <text>`

Storage:

- `./.alyce/memory/MEMORY.md`, unless overridden by runtime config

Behavior:

- survives across sessions
- is also injected into the memory prompt section

## Auto Summary

Behavior:

- starts after the conversation passes a threshold
- does not update on every turn
- compresses recent work into a reusable summary

It reduces context growth, but it does not replace conversation compaction.

## Conversation Compaction

This is the layer that keeps the full message history from growing forever.

After compaction:

- the main system message stays
- a structured compaction summary message is inserted
- recent raw turns remain
- older turns are collapsed into summary form

The goal is not to remember everything verbatim. The goal is to keep the useful parts available without dragging the full transcript forward forever.

## Timestamp Injection

If `messageTimestampsEnabled` is on:

- the request gets a dedicated `# Current System Time` system block
- the block contains the current local system date and time for the reply being generated

This is injected at API request time so the visible terminal transcript stays clean and prior messages are not polluted with timestamp text.

## How to Inspect the Real Request

If you need to verify whether something is truly reaching the model, use:

```text
/context
```

That shows the next-turn payload after runtime shaping.

## Practical Guidance

### Use `/remember` for:

- reusable facts
- user preferences
- project knowledge that should persist

### Use raw conversation history for:

- nearby tool results
- short-lived discussion context
- the most recent working state

I suppose the shortest version is this: Alyce tries to separate durable instructions from temporary conversation, and summary from transcript, so the context does not turn into a nervous pile of everything at once.
