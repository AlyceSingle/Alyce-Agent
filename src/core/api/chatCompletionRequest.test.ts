import assert from "node:assert/strict";
import { buildChatCompletionRequest } from "./chatCompletionRequest.js";

function runTests() {
  testOmitsEmptyTools();
  testOmitsToolChoiceWithoutTools();
  testIncludesNonEmptyTools();
  testEmptyAssistantToolCallContentStaysEmpty();
  testEmptyAssistantContentStaysEmpty();
  testEmptyToolContentGetsPlaceholder();
  console.log("chatCompletionRequest tests passed");
}

function testOmitsEmptyTools() {
  const request = buildChatCompletionRequest({
    model: "test-model",
    messages: [
      {
        role: "user",
        content: "hello"
      }
    ],
    tools: []
  });

  assert.equal("tools" in request, false);
}

function testOmitsToolChoiceWithoutTools() {
  const request = buildChatCompletionRequest({
    model: "test-model",
    messages: [
      {
        role: "user",
        content: "hello"
      }
    ],
    tools: [],
    toolChoice: "auto"
  });

  assert.equal("tool_choice" in request, false);
}

function testIncludesNonEmptyTools() {
  const request = buildChatCompletionRequest({
    model: "test-model",
    messages: [
      {
        role: "user",
        content: "hello"
      }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "TestTool",
          description: "Test tool",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      }
    ]
  });

  assert.equal(request.tools?.length, 1);
}

runTests();

function testEmptyAssistantToolCallContentStaysEmpty() {
  const request = buildChatCompletionRequest({
    model: "test-model",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "Read",
              arguments: "{\"file_path\":\"src/a.ts\"}"
            }
          }
        ]
      }
    ],
    tools: []
  });

  const assistant = request.messages[0];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") {
    assert.equal(assistant.content, "");
  }
}

function testEmptyAssistantContentStaysEmpty() {
  const request = buildChatCompletionRequest({
    model: "test-model",
    messages: [
      {
        role: "assistant",
        content: "   "
      }
    ],
    tools: []
  });

  const assistant = request.messages[0];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") {
    assert.equal(assistant.content, "");
  }
}

function testEmptyToolContentGetsPlaceholder() {
  const request = buildChatCompletionRequest({
    model: "test-model",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: ""
      }
    ],
    tools: []
  });

  const tool = request.messages[0];
  assert.equal(tool?.role, "tool");
  if (tool?.role === "tool") {
    assert.equal(tool.content, "(tool returned empty output)");
  }
}
