import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  createModelAdapter,
  getModelAdapterAvailability,
  type ChatCompletionAdapter
} from "./modelAdapters.js";
import { sendChatCompletion } from "./sendChatCompletion.js";
import type { ResolvedModelProfile } from "../providers/types.js";

async function runTests() {
  await testAdapterRequestUsesProviderModelId();
  testOpenAIProviderWithoutBaseUrlIsAvailable();
  testLocalProviderWithBaseUrlDoesNotRequireApiKey();
  testLocalProviderRequiresBaseUrl();
  testAnthropicProviderRequiresOpenAICompatibleBaseUrl();
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

function testAnthropicProviderRequiresOpenAICompatibleBaseUrl() {
  const resolvedModel = createResolvedModel({
    providerId: "anthropic",
    modelId: "claude-sonnet-4.6",
    kind: "anthropic",
    apiKey: "test-key"
  });
  const availability = getModelAdapterAvailability(resolvedModel);

  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /OpenAI-compatible baseURL/);
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

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
