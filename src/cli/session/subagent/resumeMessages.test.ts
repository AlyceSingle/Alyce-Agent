import assert from "node:assert/strict";
import OpenAI from "openai";
import { prepareResumableSubagentMessages } from "./resumeMessages.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function runTests() {
  testUnresolvedToolCallsAreDropped();
  testPartialToolCallPairsAreTrimmed();
  testWhitespaceOnlyAssistantMessagesAreDropped();
  console.log("subagentResumeMessages tests passed");
}

function testUnresolvedToolCallsAreDropped() {
  const messages: MessageParam[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-unresolved",
          type: "function",
          function: {
            name: "TaskList",
            arguments: "{}"
          }
        }
      ]
    },
    { role: "assistant", content: "final answer" }
  ];

  const resumed = prepareResumableSubagentMessages(messages);
  assert.equal(resumed.length, 3);
  assert.deepEqual(resumed.map((message) => message.role), ["system", "user", "assistant"]);
  assert.equal((resumed[2] as { content?: unknown }).content, "final answer");
}

function testPartialToolCallPairsAreTrimmed() {
  const messages: MessageParam[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "do work" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "TaskGet",
            arguments: "{\"task_id\":\"1\"}"
          }
        },
        {
          id: "call-2",
          type: "function",
          function: {
            name: "TaskGet",
            arguments: "{\"task_id\":\"2\"}"
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      content: "ok"
    },
    {
      role: "tool",
      tool_call_id: "orphan-id",
      content: "drop me"
    }
  ];

  const resumed = prepareResumableSubagentMessages(messages);
  assert.equal(resumed.length, 4);
  assert.deepEqual(resumed.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  const assistant = resumed[2] as {
    role: "assistant";
    tool_calls?: Array<{ id: string }>;
  };
  assert.equal(assistant.tool_calls?.length, 1);
  assert.equal(assistant.tool_calls?.[0]?.id, "call-1");
  assert.equal((messages[2] as { tool_calls?: unknown[] }).tool_calls?.length, 2);
}

function testWhitespaceOnlyAssistantMessagesAreDropped() {
  const messages: MessageParam[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "hello" },
    { role: "assistant", content: " \n  \n " }
  ];

  const resumed = prepareResumableSubagentMessages(messages);
  assert.equal(resumed.length, 2);
  assert.deepEqual(resumed.map((message) => message.role), ["system", "user"]);
}

runTests();
