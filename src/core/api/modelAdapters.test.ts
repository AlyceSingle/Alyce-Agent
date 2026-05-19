import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  createModelAdapter,
  getModelAdapterAvailability,
  type ChatCompletionAdapter
} from "./modelAdapters.js";
import { sendChatCompletion } from "./sendChatCompletion.js";
import type { ResolvedModelProfile } from "../providers/types.js";
import { buildAnthropicRequest, convertAnthropicResponse } from "./anthropicAdapter.js";
import { buildGoogleRequest, convertGoogleResponse } from "./googleAdapter.js";

async function runTests() {
  await testAdapterRequestUsesProviderModelId();
  testOpenAIProviderWithoutBaseUrlIsAvailable();
  testLocalProviderWithBaseUrlDoesNotRequireApiKey();
  testLocalProviderRequiresBaseUrl();
  testAnthropicNativeProviderWithoutBaseUrlIsAvailable();
  testGoogleNativeProviderWithoutBaseUrlIsAvailable();
  testAnthropicProviderWithBaseUrlUsesCompatibleAdapter();
  testAnthropicNativeRequestConvertsTools();
  testAnthropicNativeResponseConvertsToolUse();
  testAnthropicNativeResponsePreservesThinking();
  testGoogleNativeRequestConvertsTools();
  testGoogleNativeResponseConvertsFunctionCall();
  testGoogleNativeResponsePreservesThoughtParts();
  console.log("model adapter tests passed");
}

async function testAdapterRequestUsesProviderModelId() {
  const resolvedModel = createResolvedModel({
    providerId: "openrouter",
    modelId: "anthropic/claude-sonnet-4.6",
    kind: "openrouter",
    apiKey: "test-key",
    baseURL: "https://openrouter.ai/api/v1"
  });
  let capturedRequest: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming | undefined;
  let capturedResolvedModel: ResolvedModelProfile | undefined;
  let capturedUsageModel: string | undefined;
  const adapter: ChatCompletionAdapter = {
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    kind: resolvedModel.kind,
    sendChatCompletion: async (request, options) => {
      capturedRequest = request;
      capturedResolvedModel = options.resolvedModel;
      return createResponse("ok");
    }
  };

  const response = await sendChatCompletion(adapter, {
    model: "openrouter/anthropic/claude-sonnet-4.6",
    resolvedModel,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    onUsage: (event) => {
      capturedUsageModel = event.resolvedModel?.modelId;
      assert.equal(event.retryCount, 0);
      assert.ok(event.durationMs >= 0);
    }
  });

  assert.equal(response.choices[0]?.message?.content, "ok");
  assert.equal(capturedRequest?.model, "anthropic/claude-sonnet-4.6");
  assert.equal(capturedResolvedModel, resolvedModel);
  assert.equal(capturedUsageModel, resolvedModel.modelId);
}

function testOpenAIProviderWithoutBaseUrlIsAvailable() {
  const resolvedModel = createResolvedModel({
    providerId: "openai",
    modelId: "gpt-5.2",
    kind: "openai",
    apiKey: "test-key"
  });

  assert.equal(getModelAdapterAvailability(resolvedModel).available, true);
  assert.doesNotThrow(() => createModelAdapter(resolvedModel));
}

function testLocalProviderWithBaseUrlDoesNotRequireApiKey() {
  const resolvedModel = createResolvedModel({
    providerId: "local",
    modelId: "qwen",
    kind: "local",
    baseURL: "http://127.0.0.1:11434/v1"
  });

  assert.equal(getModelAdapterAvailability(resolvedModel).available, true);
  assert.doesNotThrow(() => createModelAdapter(resolvedModel));
}

function testLocalProviderRequiresBaseUrl() {
  const resolvedModel = createResolvedModel({
    providerId: "local",
    modelId: "qwen",
    kind: "local"
  });
  const availability = getModelAdapterAvailability(resolvedModel);

  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /requires a baseURL/);
  assert.throws(() => createModelAdapter(resolvedModel), /requires a baseURL/);
}

function testAnthropicNativeProviderWithoutBaseUrlIsAvailable() {
  const resolvedModel = createResolvedModel({
    providerId: "anthropic",
    modelId: "claude-sonnet-4.6",
    kind: "anthropic",
    apiKey: "test-key"
  });
  const availability = getModelAdapterAvailability(resolvedModel);

  assert.equal(availability.available, true);
  assert.equal(createModelAdapter(resolvedModel).kind, "anthropic");
}

function testGoogleNativeProviderWithoutBaseUrlIsAvailable() {
  const resolvedModel = createResolvedModel({
    providerId: "google",
    modelId: "gemini-3-flash",
    kind: "google",
    apiKey: "test-key"
  });
  const availability = getModelAdapterAvailability(resolvedModel);

  assert.equal(availability.available, true);
  assert.equal(createModelAdapter(resolvedModel).kind, "google");
}

function testAnthropicProviderWithBaseUrlUsesCompatibleAdapter() {
  const resolvedModel = createResolvedModel({
    providerId: "anthropic",
    modelId: "claude-through-gateway",
    kind: "anthropic",
    apiKey: "test-key",
    baseURL: "https://gateway.example/v1"
  });
  const availability = getModelAdapterAvailability(resolvedModel);

  assert.equal(availability.available, true);
  assert.doesNotThrow(() => createModelAdapter(resolvedModel));
}

function testAnthropicNativeRequestConvertsTools() {
  const request = buildAnthropicRequest({
    model: "claude-sonnet-4.6",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" }
    ],
    tools: [createTool()],
    tool_choice: "auto"
  }, createResolvedModel({
    providerId: "anthropic",
    modelId: "claude-sonnet-4.6",
    kind: "anthropic",
    apiKey: "test-key",
    maxOutputTokens: 1234
  }));

  assert.equal(request.model, "claude-sonnet-4.6");
  assert.equal(request.max_tokens, 1234);
  assert.equal(request.system, "system prompt");
  assert.equal(request.messages[0]?.role, "user");
  assert.equal(request.tools?.[0]?.name, "Read");
}

function testAnthropicNativeResponseConvertsToolUse() {
  const response = convertAnthropicResponse({
    id: "msg_1",
    model: "claude-sonnet-4.6",
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "checking" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "README.md" } }
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5
    }
  }, "claude-sonnet-4.6");

  assert.equal(response.choices[0]?.finish_reason, "tool_calls");
  assert.equal(response.choices[0]?.message.tool_calls?.[0]?.function.name, "Read");
  assert.equal(response.usage?.total_tokens, 15);
}

function testAnthropicNativeResponsePreservesThinking() {
  const response = convertAnthropicResponse({
    id: "msg_1",
    model: "claude-sonnet-4.6",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "Need a short answer." },
      { type: "text", text: "answer" }
    ]
  }, "claude-sonnet-4.6");
  const message = response.choices[0]?.message as unknown as Record<string, unknown> | undefined;

  assert.equal(response.choices[0]?.message.content, "answer");
  assert.equal(message?.reasoning_content, "Need a short answer.");
}

function testGoogleNativeRequestConvertsTools() {
  const request = buildGoogleRequest({
    model: "gemini-3-flash",
    messages: [
      { role: "system", content: "system prompt" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"README.md\"}" }
        }]
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file content"
      }
    ],
    tools: [createTool()],
    tool_choice: "auto"
  }, createResolvedModel({
    providerId: "google",
    modelId: "gemini-3-flash",
    kind: "google",
    apiKey: "test-key",
    maxOutputTokens: 2048
  }));

  assert.equal(request.systemInstruction?.parts[0]?.text, "system prompt");
  assert.equal(request.contents[0]?.role, "model");
  assert.equal("functionCall" in (request.contents[0]?.parts[0] ?? {}), true);
  assert.equal("functionResponse" in (request.contents[1]?.parts[0] ?? {}), true);
  assert.equal(request.tools?.[0]?.functionDeclarations[0]?.name, "Read");
  assert.equal(request.generationConfig?.maxOutputTokens, 2048);
}

function testGoogleNativeResponseConvertsFunctionCall() {
  const response = convertGoogleResponse({
    candidates: [{
      finishReason: "STOP",
      content: {
        parts: [
          { text: "checking" },
          { functionCall: { name: "Read", args: { path: "README.md" } } }
        ]
      }
    }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15
    }
  }, "gemini-3-flash");

  assert.equal(response.choices[0]?.message.tool_calls?.[0]?.function.name, "Read");
  assert.equal(response.usage?.total_tokens, 15);
}

function testGoogleNativeResponsePreservesThoughtParts() {
  const response = convertGoogleResponse({
    candidates: [{
      finishReason: "STOP",
      content: {
        parts: [
          { text: "Need a short answer.", thought: true },
          { text: "answer" }
        ]
      }
    }]
  }, "gemini-3-flash");
  const message = response.choices[0]?.message as unknown as Record<string, unknown> | undefined;

  assert.equal(response.choices[0]?.message.content, "answer");
  assert.equal(message?.reasoning_content, "Need a short answer.");
}

function createResolvedModel(
  input: Pick<ResolvedModelProfile, "providerId" | "modelId" | "kind"> &
    Partial<ResolvedModelProfile>
): ResolvedModelProfile {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    modelRef: {
      providerId: input.providerId,
      modelId: input.modelId
    },
    label: input.label ?? input.modelId,
    provider: input.provider ?? {
      id: input.providerId,
      label: input.providerId,
      kind: input.kind,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.baseURL ? { baseURL: input.baseURL } : {})
    },
    kind: input.kind,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
    contextWindow: input.contextWindow ?? 128_000,
    contextWindowSource: input.contextWindowSource ?? "fallback",
    contextWindowLabel: input.contextWindowLabel ?? "fallback default",
    ...(input.contextWindowMatchedPattern
      ? { contextWindowMatchedPattern: input.contextWindowMatchedPattern }
      : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.inputCostPerMillionTokens !== undefined
      ? { inputCostPerMillionTokens: input.inputCostPerMillionTokens }
      : {}),
    ...(input.outputCostPerMillionTokens !== undefined
      ? { outputCostPerMillionTokens: input.outputCostPerMillionTokens }
      : {})
  };
}

function createResponse(content: string): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content,
          refusal: null
        }
      }
    ]
  };
}

function createTool(): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"]
      }
    }
  };
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
