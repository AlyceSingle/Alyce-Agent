import assert from "node:assert/strict";
import {
  extractChatMessageText,
  extractCollapsedMessageText,
  extractMessageText
} from "./messageText.js";

function runTests() {
  assert.equal(extractMessageText("hello"), "hello");
  assert.equal(extractMessageText([{ type: "text", text: "a" }, { text: "b" }]), "a\nb");
  assert.equal(extractCollapsedMessageText("  a \n b  "), "a b");

  assert.equal(
    extractChatMessageText({
      role: "tool",
      tool_call_id: "1",
      content: "tool-out"
    }),
    "tool-out"
  );

  assert.equal(
    extractChatMessageText({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: "{}" }
        }
      ]
    }, { includeToolCallSummary: true }),
    "Requested tools: Read"
  );

  console.log("messageText tests passed");
}

runTests();
