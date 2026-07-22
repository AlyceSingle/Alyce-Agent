import assert from "node:assert/strict";
import {
  buildModelListUrl,
  fetchOpenAICompatibleModels,
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAICompatibleModels,
  refreshProviderModels
} from "./modelDiscovery.js";
import type { ProviderProfile } from "./types.js";

async function runTests() {
  testBuildModelListUrl();
  testParseOpenAICompatibleModels();
  testParseAnthropicModels();
  testParseGoogleModels();
  await testFetchOpenAICompatibleModelsSendsAuthHeaders();
  await testRefreshProviderModelsFallsBackOnFailure();
  await testRefreshKeepsConfigOnlyModels();
  console.log("modelDiscovery tests passed");
}

function testBuildModelListUrl() {
  assert.equal(buildModelListUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
  assert.equal(buildModelListUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/models");
}

function testParseOpenAICompatibleModels() {
  const models = parseOpenAICompatibleModels({
    data: [
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "gpt-5.1-codex" },
      { nope: true },
      // OpenRouter 风格：顶层 + top_provider 上下文/输出上限
      {
        id: "openrouter/meta-llama/llama-3.1-70b",
        name: "Llama 3.1 70B",
        context_length: 131_072,
        top_provider: {
          context_length: 131_072,
          max_completion_tokens: 16_384
        }
      },
      // vLLM 风格
      {
        id: "qwen2.5-72b",
        max_model_len: 32_768
      },
      // max_tokens 通常是 completion 默认值，不能当 context_window
      {
        id: "tiny-completion-default",
        max_tokens: 4_096
      },
      // 过小的 context_length 视为脏数据忽略
      {
        id: "too-small-context",
        context_length: 2_048
      }
    ]
  });

  assert.deepEqual(models, {
    "gpt-5.2": { label: "GPT-5.2" },
    "gpt-5.1-codex": {},
    "openrouter/meta-llama/llama-3.1-70b": {
      label: "Llama 3.1 70B",
      contextWindow: 131_072,
      maxOutputTokens: 16_384
    },
    "qwen2.5-72b": {
      contextWindow: 32_768
    },
    "tiny-completion-default": {},
    "too-small-context": {}
  });
}

function testParseAnthropicModels() {
  const models = parseAnthropicModels({
    data: [
      { id: "claude-sonnet-4.6", display_name: "Claude Sonnet 4.6" }
    ]
  });

  assert.deepEqual(models, {
    "claude-sonnet-4.6": { label: "Claude Sonnet 4.6" }
  });
}

function testParseGoogleModels() {
  const models = parseGoogleModels({
    models: [
      {
        name: "models/gemini-3-flash",
        displayName: "Gemini 3 Flash",
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ["generateContent"]
      },
      {
        name: "models/embedding-001",
        supportedGenerationMethods: ["embedContent"]
      }
    ]
  });

  assert.deepEqual(models, {
    "gemini-3-flash": {
      label: "Gemini 3 Flash",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536
    }
  });
}

async function testFetchOpenAICompatibleModelsSendsAuthHeaders() {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const models = await fetchOpenAICompatibleModels({
    provider: {
      id: "openai",
      label: "OpenAI",
      kind: "openai",
      apiKey: "openai-key",
      baseURL: "https://api.openai.com/v1"
    },
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined
      });
      return new Response(JSON.stringify({
        data: [
          { id: "gpt-5.2", name: "GPT-5.2" }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });

  assert.deepEqual(models, {
    "gpt-5.2": { label: "GPT-5.2" }
  });
  assert.deepEqual(calls, [
    {
      url: "https://api.openai.com/v1/models",
      authorization: "Bearer openai-key"
    }
  ]);
}

async function testRefreshProviderModelsFallsBackOnFailure() {
  const provider: ProviderProfile = {
    id: "local",
    label: "Local",
    kind: "local",
    models: {
      fallback: { label: "Fallback" }
    }
  };
  const result = await refreshProviderModels({ provider });

  assert.equal(result.source, "fallback");
  assert.match(result.error ?? "", /does not define a model list endpoint/);
  assert.deepEqual(result.models, {
    fallback: { label: "Fallback" }
  });
}

async function testRefreshKeepsConfigOnlyModels() {
  const provider: ProviderProfile = {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    models: {
      "custom/keep-me": {
        label: "Keep Me",
        contextWindow: 99_000
      },
      "openai/gpt-5.2": {
        label: "Old Label",
        contextWindow: 100_000
      }
    }
  };

  const result = await refreshProviderModels({
    provider,
    connector: {
      id: "openrouter",
      label: "OpenRouter",
      models: async () => ({
        "openai/gpt-5.2": {
          label: "Live GPT",
          contextWindow: 400_000
        }
      })
    }
  });

  assert.equal(result.source, "live");
  assert.deepEqual(result.models["custom/keep-me"], {
    label: "Keep Me",
    contextWindow: 99_000
  });
  assert.deepEqual(result.models["openai/gpt-5.2"], {
    label: "Live GPT",
    contextWindow: 400_000
  });
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
