import assert from "node:assert/strict";
import type OpenAI from "openai";
import { createSkillContextMessage } from "../api/generatedMessages.js";
import {
  ContextBudgetService,
  snipOversizedToolOutputs
} from "./contextBudget.js";
import { resolveModelContextWindow } from "./modelContextWindows.js";

function createRequest(content: string): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    model: "gpt-5",
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content
      }
    ]
  };
}

function createLongText(char: string, length = 24_000) {
  return char.repeat(length);
}

function runTests() {
  testModelContextWindowOverridesWin();
  testModelNameContextSuffixInference();
  testUnknownModelFallsBackToDefault();
  testPreviewEstimatesDoNotCalibrateUsage();
  testRecordedEstimatesCalibrateUsage();
  testResolvedModelContextWindowFeedsBudget();
  testLatestToolOutputsAreProtectedAcrossGeneratedContextMessages();
  testSnippingNeverReportsNegativeTokenSavings();
  console.log("contextBudget tests passed");
}

function testResolvedModelContextWindowFeedsBudget() {
  const service = new ContextBudgetService();
  const snapshot = service.estimateRequest(createRequest("hello"), {
    resolvedModel: {
      providerId: "local",
      modelId: "qwen",
      contextWindow: 256_000,
      contextWindowSource: "provider_profile",
      contextWindowLabel: "provider profile: local/qwen",
      contextWindowMatchedPattern: "local/qwen"
    }
  });

  assert.equal(snapshot.model, "local/qwen");
  assert.equal(snapshot.contextWindow, 256_000);
  assert.equal(snapshot.contextWindowSource, "provider_profile");
  assert.equal(snapshot.contextWindowMatchedPattern, "local/qwen");
}

function testModelContextWindowOverridesWin() {
  const resolved = resolveModelContextWindow("provider/custom-fast-model", {
    "custom fast": 512_000
  });

  assert.equal(resolved.contextWindow, 512_000);
  assert.equal(resolved.source, "override");
}

function testModelNameContextSuffixInference() {
  const resolved = resolveModelContextWindow("provider/claude-sonnet-4-1m");

  assert.equal(resolved.contextWindow, 1_000_000);
  assert.equal(resolved.source, "model_name");

  const kSuffix = resolveModelContextWindow("local/qwen-128k");
  assert.equal(kSuffix.contextWindow, 131_072);
  assert.equal(kSuffix.source, "model_name");
}

function testUnknownModelFallsBackToDefault() {
  const resolved = resolveModelContextWindow("gemini25pro");

  assert.equal(resolved.contextWindow, 128_000);
  assert.equal(resolved.source, "fallback");
}

function testPreviewEstimatesDoNotCalibrateUsage() {
  const service = new ContextBudgetService();
  const initial = service.estimateRequest(createRequest("hello"));

  service.estimateRequest(createRequest(createLongText("x")));
  service.recordUsage({ prompt_tokens: 10 });

  const after = service.estimateRequest(createRequest("hello"));
  assert.equal(after.calibrationScale, initial.calibrationScale);
}

function testRecordedEstimatesCalibrateUsage() {
  const service = new ContextBudgetService();
  const request = createRequest(createLongText("x"));
  const before = service.estimateRequest(request);

  service.estimateRequest(request, { recordForUsage: true });
  service.recordUsage({ prompt_tokens: before.rawEstimatedInputTokens * 2 });

  const after = service.estimateRequest(request);
  assert.equal(after.calibrationScale, 2);
}

function testLatestToolOutputsAreProtectedAcrossGeneratedContextMessages() {
  const latestToolOutput = createLongText("a");
  const olderToolOutput = createLongText("b");
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "older-call",
          type: "function",
          function: {
            name: "OldTool",
            arguments: "{}"
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "older-call",
      content: olderToolOutput
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "latest-call",
          type: "function",
          function: {
            name: "LatestTool",
            arguments: "{}"
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "latest-call",
      content: latestToolOutput
    },
    createSkillContextMessage("supplemental context")
  ];

  const result = snipOversizedToolOutputs(messages, 18_000);

  assert.equal(result.changed, true);
  assert.equal(result.snippedMessages, 1);
  assert.match(String(messages[1]?.content), /^\[Alyce context snip\]/);
  assert.equal(messages[3]?.content, latestToolOutput);
}

function testSnippingNeverReportsNegativeTokenSavings() {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "tool",
      tool_call_id: "call_1",
      content: createLongText("x", 18_100)
    }
  ];

  const result = snipOversizedToolOutputs(messages, 18_000);

  assert.equal(result.changed, true);
  assert.equal(result.estimatedTokensSaved >= 0, true);
}

runTests();
