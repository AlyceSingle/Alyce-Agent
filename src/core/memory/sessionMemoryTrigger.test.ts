import assert from "node:assert/strict";
import type OpenAI from "openai";
import { SessionMemoryTrigger } from "./sessionMemoryTrigger.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function runTests() {
  testInitialExtractionWaitsForTokenThreshold();
  testNaturalBreakNeedsOnlyTokenDeltaAfterInitialization();
  testToolCallTurnWaitsForToolThreshold();
  testCountsToolCallsOnlyAfterLastExtraction();
  console.log("sessionMemoryTrigger tests passed");
}

function testInitialExtractionWaitsForTokenThreshold() {
  const trigger = new SessionMemoryTrigger({
    initialTokens: 10,
    updateTokens: 5,
    toolCallsBetweenUpdates: 2
  });
  const messages = createConversation();

  const below = trigger.shouldExtract({ messages, currentTokens: 9 });
  const met = trigger.shouldExtract({ messages, currentTokens: 10 });

  assert.equal(below.shouldExtract, false);
  assert.equal(below.reason, "below_initial_tokens");
  assert.equal(met.shouldExtract, true);
  assert.equal(met.reason, "should_extract");
}

function testNaturalBreakNeedsOnlyTokenDeltaAfterInitialization() {
  const trigger = new SessionMemoryTrigger({
    initialTokens: 10,
    updateTokens: 5,
    toolCallsBetweenUpdates: 3
  });
  const messages = createConversation();
  trigger.recordExtraction({
    messages,
    currentTokens: 10,
    now: new Date("2026-01-01T00:00:00.000Z")
  });

  const below = trigger.shouldExtract({
    messages: [...messages, { role: "user", content: "next" }],
    currentTokens: 14
  });
  const met = trigger.shouldExtract({
    messages: [...messages, { role: "user", content: "next" }],
    currentTokens: 15
  });

  assert.equal(below.shouldExtract, false);
  assert.equal(below.reason, "below_update_tokens");
  assert.equal(met.shouldExtract, true);
  assert.equal(met.reason, "should_extract");
  assert.equal(met.lastAssistantTurnHasToolCalls, false);
}

function testToolCallTurnWaitsForToolThreshold() {
  const trigger = new SessionMemoryTrigger({
    initialTokens: 10,
    updateTokens: 5,
    toolCallsBetweenUpdates: 2
  });
  const messages = createConversation();
  trigger.recordExtraction({
    messages,
    currentTokens: 10,
    now: new Date("2026-01-01T00:00:00.000Z")
  });

  const oneToolCall = [
    ...messages,
    assistantToolCallMessage("call_1", "Read")
  ];
  const twoToolCalls = [
    ...messages,
    assistantToolCallMessage("call_1", "Read"),
    assistantToolCallMessage("call_2", "Grep")
  ];

  const waiting = trigger.shouldExtract({ messages: oneToolCall, currentTokens: 20 });
  const met = trigger.shouldExtract({ messages: twoToolCalls, currentTokens: 20 });

  assert.equal(waiting.shouldExtract, false);
  assert.equal(waiting.reason, "waiting_for_tool_calls_or_break");
  assert.equal(met.shouldExtract, true);
  assert.equal(met.reason, "should_extract");
}

function testCountsToolCallsOnlyAfterLastExtraction() {
  const trigger = new SessionMemoryTrigger({
    initialTokens: 10,
    updateTokens: 5,
    toolCallsBetweenUpdates: 2
  });
  const messages = [
    ...createConversation(),
    assistantToolCallMessage("old_call", "Read")
  ];
  trigger.recordExtraction({
    messages,
    currentTokens: 10,
    now: new Date("2026-01-01T00:00:00.000Z")
  });

  const nextMessages = [
    ...messages,
    assistantToolCallMessage("new_call", "Grep")
  ];
  const decision = trigger.shouldExtract({ messages: nextMessages, currentTokens: 20 });

  assert.equal(decision.toolCallsSinceLastExtraction, 1);
  assert.equal(decision.shouldExtract, false);
}

function createConversation(): MessageParam[] {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ];
}

function assistantToolCallMessage(id: string, toolName: string): MessageParam {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name: toolName,
          arguments: "{}"
        }
      }
    ]
  };
}

runTests();
