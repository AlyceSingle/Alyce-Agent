import assert from "node:assert/strict";
import { buildChatCompletionRequest } from "./chatCompletionRequest.js";

function runTests() {
  testOmitsEmptyTools();
  testOmitsToolChoiceWithoutTools();
  testIncludesNonEmptyTools();
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
