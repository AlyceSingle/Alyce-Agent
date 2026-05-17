import assert from "node:assert/strict";
import {
  buildConnectionConfigState,
  getRuntimePaths
} from "../config/runtime.js";
import { resolveConnectProvider } from "./connectCommand.js";

function runTests() {
  testConnectOpenRouterUsesBuiltInProfileAndAuthStoreKey();
  testConnectOpenAIAcceptsOptionalBaseURL();
  testConnectDeepSeekUsesPresetEndpoint();
  testConnectOllamaUsesLocalPreset();
  testConnectLocalCreatesProviderProfileWithoutApiKey();
  testConnectCustomCreatesProviderProfileWithoutApiKey();
  testConnectCustomAcceptsOptionalLabel();
  testConnectRejectsMissingProvider();
  console.log("connectCommand tests passed");
}

function testConnectOpenRouterUsesBuiltInProfileAndAuthStoreKey() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider("openrouter", ["router-key"], {
    connectionState: state
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.providerId : "", "openrouter");
  assert.equal(result.ok ? result.plan.apiKey : "", "router-key");
  assert.equal(result.ok ? result.plan.model : "", "openrouter/openai/gpt-5.2");
  assert.equal(result.ok ? result.plan.providerProfile : undefined, undefined);
}

function testConnectOpenAIAcceptsOptionalBaseURL() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider("openai", ["openai-key", "gpt-5.2", "https://api.openai.com/v1"], {
    connectionState: state
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.providerId : "", "openai");
  assert.equal(result.ok ? result.plan.apiKey : "", "openai-key");
  assert.equal(result.ok ? result.plan.model : "", "gpt-5.2");
  assert.equal(result.ok ? result.plan.providerProfile?.baseURL : "", "https://api.openai.com/v1");
  assert.equal(
    result.ok && result.plan.providerProfile
      ? Object.prototype.hasOwnProperty.call(result.plan.providerProfile, "apiKey")
      : false,
    false
  );
}

function testConnectDeepSeekUsesPresetEndpoint() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider("deepseek", ["deepseek-key"], {
    connectionState: state
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.providerId : "", "deepseek");
  assert.equal(result.ok ? result.plan.apiKey : "", "deepseek-key");
  assert.equal(result.ok ? result.plan.model : "", "deepseek/deepseek-chat");
  assert.equal(result.ok ? result.plan.providerProfile : undefined, undefined);
}

function testConnectOllamaUsesLocalPreset() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider("ollama", [], {
    connectionState: state
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.providerId : "", "ollama");
  assert.equal(result.ok ? result.plan.apiKey : "unexpected", undefined);
  assert.equal(result.ok ? result.plan.model : "", "ollama/llama3.1");
  assert.equal(result.ok ? result.plan.providerProfile : undefined, undefined);
}

function testConnectLocalCreatesProviderProfileWithoutApiKey() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider("local", ["http://127.0.0.1:11434/v1", "qwen"], {
    connectionState: state
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.providerId : "", "local");
  assert.equal(result.ok ? result.plan.apiKey : "unexpected", undefined);
  assert.equal(result.ok ? result.plan.model : "", "local/qwen");
  assert.equal(result.ok ? result.plan.providerProfile?.kind : undefined, "local");
  assert.equal(result.ok ? result.plan.providerProfile?.baseURL : "", "http://127.0.0.1:11434/v1");
  assert.equal(
    result.ok && result.plan.providerProfile
      ? Object.prototype.hasOwnProperty.call(result.plan.providerProfile, "apiKey")
      : false,
    false
  );
}

function testConnectCustomCreatesProviderProfileWithoutApiKey() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider(
    "custom",
    ["company-openai", "https://proxy.example/v1", "gpt-5.2", "custom-key"],
    {
      connectionState: state
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.providerId : "", "company-openai");
  assert.equal(result.ok ? result.plan.apiKey : "", "custom-key");
  assert.equal(result.ok ? result.plan.model : "", "company-openai/gpt-5.2");
  assert.equal(result.ok ? result.plan.providerProfile?.kind : undefined, "openai-compatible");
  assert.equal(result.ok ? result.plan.providerProfile?.baseURL : "", "https://proxy.example/v1");
  assert.equal(
    result.ok && result.plan.providerProfile
      ? Object.prototype.hasOwnProperty.call(result.plan.providerProfile, "apiKey")
      : false,
    false
  );
}

function testConnectCustomAcceptsOptionalLabel() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider(
    "custom",
    ["company-openai", "https://proxy.example/v1", "gpt-5.2", "custom-key", "Company OpenAI"],
    {
      connectionState: state
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.providerProfile?.label : "", "Company OpenAI");
  assert.equal(
    result.ok && result.plan.providerProfile
      ? Object.prototype.hasOwnProperty.call(result.plan.providerProfile, "apiKey")
      : false,
    false
  );
}

function testConnectRejectsMissingProvider() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const result = resolveConnectProvider(undefined, [], {
    connectionState: state
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /Missing provider/);
  assert.match(result.ok ? "" : result.suggestions.join("\n"), /API-key presets/);
}

runTests();
