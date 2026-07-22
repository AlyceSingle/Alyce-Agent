import assert from "node:assert/strict";
import type OpenAI from "openai";
import { consumeOpenAIChatCompletionStream } from "./chatCompletionStream.js";

async function runTests() {
  await testConsumesTextAndToolCallDeltas();
  console.log("chatCompletionStream tests passed");
}

async function testConsumesTextAndToolCallDeltas() {
  const deltas: string[] = [];
  const thinking: string[] = [];

  async function* fakeStream(): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
    yield {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Hel" },
          finish_reason: null
        }
      ]
    } as OpenAI.Chat.Completions.ChatCompletionChunk;
    yield {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { content: "lo" },
          finish_reason: null
        }
      ]
    } as OpenAI.Chat.Completions.ChatCompletionChunk;
    yield {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "Glob", arguments: "{\"p" }
              }
            ]
          },
          finish_reason: null
        }
      ]
    } as OpenAI.Chat.Completions.ChatCompletionChunk;
    yield {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: "ath\":\"**/*\"}" }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    } as OpenAI.Chat.Completions.ChatCompletionChunk;
  }

  const response = await consumeOpenAIChatCompletionStream(fakeStream(), {
    model: "test-model",
    handlers: {
      onTextDelta: (text) => deltas.push(text),
      onThinkingDelta: (text) => thinking.push(text)
    }
  });

  assert.equal(response.choices[0]?.message?.content, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(response.choices[0]?.finish_reason, "tool_calls");
  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  assert.equal(toolCall && "function" in toolCall ? toolCall.function.name : "", "Glob");
  assert.equal(
    toolCall && "function" in toolCall ? toolCall.function.arguments : "",
    "{\"path\":\"**/*\"}"
  );
}

await runTests();
