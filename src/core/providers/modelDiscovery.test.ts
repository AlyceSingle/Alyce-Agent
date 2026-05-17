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
      { nope: true }
    ]
  });

  assert.deepEqual(models, {
    "gpt-5.2": { label: "GPT-5.2" },
    "gpt-5.1-codex": {}
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

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
