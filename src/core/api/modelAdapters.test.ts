import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  createModelAdapter,
  getModelAdapterAvailability,
  type ChatCompletionAdapter
} from "./modelAdapters.js";
import { getFunctionToolCallName } from "./openaiFunctionTools.js";
import { buildPatchedChatCompletionRequest, sendChatCompletion } from "./sendChatCompletion.js";
import type { ResolvedModelProfile } from "../providers/types.js";
import {
  buildAnthropicRequest,
  consumeAnthropicMessageStream,
  convertAnthropicResponse
} from "./anthropicAdapter.js";
import {
  buildGoogleGenerateContentUrl,
  buildGoogleRequest,
  consumeGoogleGenerateContentStream,
  convertGoogleResponse
} from "./googleAdapter.js";

async function runTests() {
  await testAdapterRequestUsesProviderModelId();
  testOpenAIProviderWithoutBaseUrlIsAvailable();
  testLocalProviderWithBaseUrlDoesNotRequireApiKey();
  testLocalProviderRequiresBaseUrl();
  testAnthropicNativeProviderWithoutBaseUrlIsAvailable();
  testGoogleNativeProviderWithoutBaseUrlIsAvailable();
  testAnthropicProviderWithBaseUrlUsesCompatibleAdapter();
  testAnthropicNativeRequestConvertsTools();
  testAnthropicNativeRequestInlinesImagesAndPdfs();
  testGoogleNativeRequestInlinesImagesAndPdfs();
  testAnthropicNativeResponseConvertsToolUse();
  testAnthropicNativeResponseSplitsCacheTokens();
  testAnthropicNativeResponsePreservesThinking();
  testGoogleNativeRequestConvertsTools();
  testGoogleNativeResponseConvertsFunctionCall();
  testGoogleNativeResponsePreservesThoughtParts();
  await testAnthropicStreamAssemblesResponse();
  await testGoogleStreamAssemblesResponse();
  testGoogleStreamingUrlUsesSse();
  testTemperatureResolutionFromModelProfile();
  testReasoningModelOmitsTemperature();
  testAnthropicThinkingBudget();
  testGoogleThinkingBudget();
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
  assert.deepEqual(request.system, [{
    type: "text",
    text: "system prompt",
    cache_control: { type: "ephemeral" }
  }]);
  assert.equal(request.messages[0]?.role, "user");
  assert.equal(request.tools?.[0]?.name, "Read");
  const lastMessage = request.messages[request.messages.length - 1];
  const lastBlock = lastMessage?.content[lastMessage.content.length - 1];
  assert.deepEqual(lastBlock?.cache_control, { type: "ephemeral" });
}

function createMultimodalUserMessage(): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: "user",
    content: [
      { type: "text", text: "Attached image: screenshot.png" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "auto" }
      },
      {
        type: "file",
        file: { filename: "doc.pdf", file_data: "data:application/pdf;base64,cGRm" }
      }
    ]
  };
}

function testAnthropicNativeRequestInlinesImagesAndPdfs() {
  const request = buildAnthropicRequest({
    model: "claude-sonnet-4.6",
    messages: [createMultimodalUserMessage()],
    tools: []
  }, createResolvedModel({
    providerId: "anthropic",
    modelId: "claude-sonnet-4.6",
    kind: "anthropic",
    apiKey: "test-key"
  }));
  const blocks = request.messages[0]?.content ?? [];

  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: "text", text: "Attached image: screenshot.png" });
  assert.deepEqual(blocks[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" }
  });
  assert.deepEqual(blocks[2], {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
    cache_control: { type: "ephemeral" }
  });
}

function testGoogleNativeRequestInlinesImagesAndPdfs() {
  const request = buildGoogleRequest({
    model: "gemini-3-flash",
    messages: [createMultimodalUserMessage()],
    tools: []
  }, createResolvedModel({
    providerId: "google",
    modelId: "gemini-3-flash",
    kind: "google",
    apiKey: "test-key"
  }));
  const parts = request.contents[0]?.parts ?? [];

  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { text: "Attached image: screenshot.png" });
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
  assert.deepEqual(parts[2], { inlineData: { mimeType: "application/pdf", data: "cGRm" } });
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
  assert.equal(getFunctionToolCallName(response.choices[0]?.message.tool_calls?.[0]), "Read");
  assert.equal(response.usage?.total_tokens, 15);
}

function testAnthropicNativeResponseSplitsCacheTokens() {
  const response = convertAnthropicResponse({
    id: "msg_1",
    model: "claude-sonnet-4.6",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "hi" }],
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 1500,
      output_tokens: 20
    }
  }, "claude-sonnet-4.6");

  assert.deepEqual(response.usage, {
    prompt_tokens: 2000,
    completion_tokens: 20,
    total_tokens: 2020,
    prompt_tokens_details: { cached_tokens: 1500 },
    cache_creation_tokens: 400
  });
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

  assert.equal(getFunctionToolCallName(response.choices[0]?.message.tool_calls?.[0]), "Read");
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

function createSseResponse(events: Array<{ event?: string; data: unknown }>): Response {
  const payload = events
    .map((entry) =>
      (entry.event ? `event: ${entry.event}\n` : "") + `data: ${JSON.stringify(entry.data)}\n\n`)
    .join("");
  return new Response(payload, {
    headers: { "content-type": "text/event-stream" }
  });
}

async function testAnthropicStreamAssemblesResponse() {
  const textDeltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const response = await consumeAnthropicMessageStream(createSseResponse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_stream_1",
          model: "claude-sonnet-4.6",
          usage: { input_tokens: 7, cache_read_input_tokens: 3 }
        }
      }
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "thinking" } }
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 1, content_block: { type: "text" } }
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } }
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } }
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_9", name: "Read" }
      }
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "{\"path\":" }
      }
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "\"README.md\"}" }
      }
    },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 11 } }
    },
    { event: "message_stop", data: { type: "message_stop" } }
  ]), {
    modelId: "claude-sonnet-4.6",
    handlers: {
      onTextDelta: (text) => textDeltas.push(text),
      onThinkingDelta: (text) => thinkingDeltas.push(text)
    }
  });
  const message = response.choices[0]?.message;

  assert.deepEqual(textDeltas, ["Hello ", "world"]);
  assert.deepEqual(thinkingDeltas, ["hmm"]);
  assert.equal(response.id, "msg_stream_1");
  assert.equal(message?.content, "Hello world");
  assert.equal((message as unknown as Record<string, unknown>)?.reasoning_content, "hmm");
  assert.equal(response.choices[0]?.finish_reason, "tool_calls");
  assert.equal(getFunctionToolCallName(message?.tool_calls?.[0]), "Read");
  assert.equal(
    (message?.tool_calls?.[0] as { function?: { arguments?: string } })?.function?.arguments,
    "{\"path\":\"README.md\"}"
  );
  assert.deepEqual(response.usage, {
    prompt_tokens: 10,
    completion_tokens: 11,
    total_tokens: 21,
    prompt_tokens_details: { cached_tokens: 3 }
  });
}

async function testGoogleStreamAssemblesResponse() {
  const textDeltas: string[] = [];
  const response = await consumeGoogleGenerateContentStream(createSseResponse([
    {
      data: {
        candidates: [{ content: { parts: [{ text: "Need a plan.", thought: true }, { text: "Hel" }] } }]
      }
    },
    {
      data: {
        candidates: [{
          finishReason: "STOP",
          content: {
            parts: [
              { text: "lo" },
              { functionCall: { name: "Read", args: { path: "README.md" } } }
            ]
          }
        }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 }
      }
    }
  ]), {
    modelId: "gemini-3-flash",
    handlers: {
      onTextDelta: (text) => textDeltas.push(text)
    }
  });
  const message = response.choices[0]?.message;

  assert.deepEqual(textDeltas, ["Hel", "lo"]);
  assert.equal(message?.content, "Hello");
  assert.equal((message as unknown as Record<string, unknown>)?.reasoning_content, "Need a plan.");
  assert.equal(getFunctionToolCallName(message?.tool_calls?.[0]), "Read");
  assert.deepEqual(response.usage, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
}

function testGoogleStreamingUrlUsesSse() {
  const url = buildGoogleGenerateContentUrl("gemini-3-flash", "test-key", true);

  assert.match(url, /:streamGenerateContent\?/);
  assert.match(url, /alt=sse/);
  assert.match(buildGoogleGenerateContentUrl("gemini-3-flash", "test-key"), /:generateContent\?/);
}

function testTemperatureResolutionFromModelProfile() {
  const base = {
    model: "gpt-4.1",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: []
  };

  const withProfileTemperature = buildPatchedChatCompletionRequest({
    ...base,
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "gpt-4.1",
      kind: "openai",
      temperature: 0.7
    })
  });
  assert.equal(withProfileTemperature.temperature, 0.7);

  const withExplicitTemperature = buildPatchedChatCompletionRequest({
    ...base,
    temperature: 0.5,
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "gpt-4.1",
      kind: "openai",
      temperature: 0.7
    })
  });
  assert.equal(withExplicitTemperature.temperature, 0.5);

  const withNullTemperature = buildPatchedChatCompletionRequest({
    ...base,
    temperature: 0.5,
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "gpt-4.1",
      kind: "openai",
      temperature: null
    })
  });
  assert.equal("temperature" in withNullTemperature, false);

  const withDefault = buildPatchedChatCompletionRequest(base);
  assert.equal(withDefault.temperature, 0.2);
}

function testReasoningModelOmitsTemperature() {
  const base = {
    model: "o3-mini",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: []
  };

  const oSeries = buildPatchedChatCompletionRequest({
    ...base,
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "o3-mini",
      kind: "openai"
    })
  });
  assert.equal("temperature" in oSeries, false);

  const withEffort = buildPatchedChatCompletionRequest({
    ...base,
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "gpt-5.2",
      kind: "openai",
      reasoningEffort: "high"
    })
  });
  assert.equal("temperature" in withEffort, false);
  assert.equal(withEffort.reasoning_effort, "high");
}

function testAnthropicThinkingBudget() {
  const request = buildAnthropicRequest({
    model: "claude-sonnet-4.6",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    temperature: 0.2
  }, createResolvedModel({
    providerId: "anthropic",
    modelId: "claude-sonnet-4.6",
    kind: "anthropic",
    apiKey: "test-key",
    maxOutputTokens: 4096,
    thinkingBudgetTokens: 8000
  }));

  assert.deepEqual(request.thinking, { type: "enabled", budget_tokens: 8000 });
  assert.equal("temperature" in request, false);
  assert.equal(request.max_tokens, 9024);
}

function testGoogleThinkingBudget() {
  const request = buildGoogleRequest({
    model: "gemini-3-flash",
    messages: [{ role: "user", content: "hi" }],
    tools: []
  }, createResolvedModel({
    providerId: "google",
    modelId: "gemini-3-flash",
    kind: "google",
    apiKey: "test-key",
    thinkingBudgetTokens: 2048
  }));

  assert.deepEqual(request.generationConfig?.thinkingConfig, {
    thinkingBudget: 2048,
    includeThoughts: true
  });
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
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.thinkingBudgetTokens !== undefined
      ? { thinkingBudgetTokens: input.thinkingBudgetTokens }
      : {}),
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
