import assert from "node:assert/strict";
import {
  buildConnectionConfigState,
  getRuntimePaths
} from "../../config/runtime.js";
import {
  CONNECTABLE_PROVIDER_PRESET_IDS,
  getBuiltInProviderProfile
} from "../../core/providers/defaults.js";
import {
  buildConnectProviderArgs,
  createInitialConnectValues,
  createConnectProviderOptions,
  filterConnectProviderOptions,
  getConnectFields,
  maskConnectSecret,
  validateConnectValues
} from "./ConnectProviderDialog.js";

function runTests() {
  testProviderOptionsReflectConnectedState();
  testProviderOptionsUseRenderedGroupOrder();
  testProviderOptionsCanBeSearched();
  testPresetProvidersEnterPicker();
  testAnthropicAndGoogleUseApiKeyForms();
  testExperimentalConnectorOptionsAreVisibleByDefault();
  testGitHubCopilotUsesAuthFlowFields();
  testPresetOptionUsesPresetFields();
  testAllPresetApiProvidersExposeEditableCredentialFields();
  testOpenAILegacyCompatibleLabelIsShownAsOpenAI();
  testOpenAIFieldsIncludeBaseURL();
  testOpenRouterFieldsIncludeBaseURL();
  testBuildConnectProviderArgsForOpenAIIncludesBaseURL();
  testBuildConnectProviderArgsForDeepSeekIncludesBaseURL();
  testBuildConnectProviderArgsForOllama();
  testBuildConnectProviderArgsForCustomIncludesOptionalLabel();
  testSecretMaskDoesNotLeakValue();
  testValidationRejectsInvalidLocalUrl();
  console.log("ConnectProviderDialog tests passed");
}

function testProviderOptionsReflectConnectedState() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      providers: {
        openrouter: {
          apiKey: "router-key"
        },
        local: {
          kind: "local",
          baseURL: "http://127.0.0.1:11434/v1"
        }
      }
    }
  });
  const options = createConnectProviderOptions(state);

  assert.equal(options.find((option) => option.id === "openrouter")?.status, "connected");
  assert.equal(options.find((option) => option.id === "local")?.status, "connected");
}

function testProviderOptionsUseRenderedGroupOrder() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const optionIds = createConnectProviderOptions(state).map((option) => option.id);

  assert.ok(optionIds.indexOf("local") > optionIds.indexOf("qwen"));
  assert.ok(optionIds.indexOf("local") < optionIds.indexOf("siliconflow"));
  assert.ok(optionIds.indexOf("custom") < optionIds.indexOf("github-copilot"));
}

function testProviderOptionsCanBeSearched() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const options = filterConnectProviderOptions(createConnectProviderOptions(state), "router");

  assert.deepEqual(options.map((option) => option.id), ["openrouter"]);
}

function testPresetProvidersEnterPicker() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const optionIds = createConnectProviderOptions(state).map((option) => option.id);

  for (const providerId of ["anthropic", "google", "deepseek", "kimi", "qwen", "siliconflow", "doubao", "ollama", "lmstudio"]) {
    assert.ok(optionIds.includes(providerId), `${providerId} should be visible in /connect`);
  }
}

function testAnthropicAndGoogleUseApiKeyForms() {
  assert.deepEqual(
    getConnectFields("anthropic").map((field) => field.key),
    ["apiKey", "baseURL", "model"]
  );
  assert.deepEqual(
    getConnectFields("google").map((field) => field.key),
    ["apiKey", "baseURL", "model"]
  );
}

function testExperimentalConnectorOptionsAreVisibleByDefault() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const optionIds = createConnectProviderOptions(state).map((option) => option.id);

  assert.ok(optionIds.includes("github-copilot"));
  assert.ok(optionIds.includes("codex"));
}

function testGitHubCopilotUsesAuthFlowFields() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const option = createConnectProviderOptions(state).find((candidate) => candidate.id === "github-copilot");

  assert.ok(option);
  assert.equal(option?.mode, "auth");
  assert.equal(option?.authMethodLabel, "Login with GitHub Copilot");
  assert.deepEqual(
    getConnectFields(option, { deploymentType: "github.com" }).map((field) => field.key),
    ["deploymentType"]
  );
  assert.deepEqual(
    getConnectFields(option, { deploymentType: "enterprise" }).map((field) => field.key),
    ["deploymentType", "enterpriseUrl"]
  );
  assert.equal(createInitialConnectValues("github-copilot", state).deploymentType, undefined);
}

function testPresetOptionUsesPresetFields() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const openai = createConnectProviderOptions(state).find((candidate) => candidate.id === "openai");
  const google = createConnectProviderOptions(state).find((candidate) => candidate.id === "google");

  assert.ok(openai);
  assert.ok(google);
  assert.deepEqual(
    openai ? getConnectFields(openai).map((field) => field.key) : [],
    ["apiKey", "baseURL", "model"]
  );
  assert.deepEqual(
    google ? getConnectFields(google).map((field) => field.key) : [],
    ["apiKey", "baseURL", "model"]
  );
}

function testAllPresetApiProvidersExposeEditableCredentialFields() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const options = createConnectProviderOptions(state);
  const apiProviderIds = CONNECTABLE_PROVIDER_PRESET_IDS.filter((providerId) => {
    const profile = getBuiltInProviderProfile(providerId);
    return profile?.kind !== "local";
  });

  for (const providerId of apiProviderIds) {
    const option = options.find((candidate) => candidate.id === providerId);
    assert.ok(option, `${providerId} should be present in /connect`);
    assert.deepEqual(
      option ? getConnectFields(option).map((field) => field.key) : [],
      ["apiKey", "baseURL", "model"],
      `${providerId} should expose credential, URL, and model fields`
    );
  }
}

function testOpenAILegacyCompatibleLabelIsShownAsOpenAI() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    env: {
      apiKey: "openai-key",
      baseURL: "https://api.openai-compatible.example/v1/",
      model: "gemini-3-flash-preview"
    }
  });
  const option = createConnectProviderOptions(state).find((candidate) => candidate.id === "openai");

  assert.equal(option?.label, "OpenAI");
}

function testOpenAIFieldsIncludeBaseURL() {
  assert.deepEqual(
    getConnectFields("openai").map((field) => field.key),
    ["apiKey", "baseURL", "model"]
  );
}

function testOpenRouterFieldsIncludeBaseURL() {
  assert.deepEqual(
    getConnectFields("openrouter").map((field) => field.key),
    ["apiKey", "baseURL", "model"]
  );
}

function testBuildConnectProviderArgsForOpenAIIncludesBaseURL() {
  const args = buildConnectProviderArgs("openai", {
    apiKey: "openai-key",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5.2"
  });

  assert.deepEqual(args, ["openai-key", "gpt-5.2", "https://api.openai.com/v1"]);
}

function testBuildConnectProviderArgsForDeepSeekIncludesBaseURL() {
  const args = buildConnectProviderArgs("deepseek", {
    apiKey: "deepseek-key",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  });

  assert.deepEqual(args, ["deepseek-key", "deepseek-chat", "https://api.deepseek.com/v1"]);
}

function testBuildConnectProviderArgsForOllama() {
  const args = buildConnectProviderArgs("ollama", {
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen3-coder"
  });

  assert.deepEqual(args, ["http://127.0.0.1:11434/v1", "qwen3-coder"]);
}

function testBuildConnectProviderArgsForCustomIncludesOptionalLabel() {
  const args = buildConnectProviderArgs("custom", {
    providerId: "siliconflow",
    label: "SiliconFlow",
    baseURL: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    apiKey: "secret-key"
  });

  assert.deepEqual(args, [
    "siliconflow",
    "https://api.siliconflow.cn/v1",
    "deepseek-ai/DeepSeek-V3",
    "secret-key",
    "SiliconFlow"
  ]);
}

function testSecretMaskDoesNotLeakValue() {
  const masked = maskConnectSecret("secret-router-key");

  assert.equal(masked.includes("secret-router-key"), false);
  assert.match(masked, /^\*+$/);
}

function testValidationRejectsInvalidLocalUrl() {
  const error = validateConnectValues("local", {
    baseURL: "not-a-url",
    model: "qwen"
  });

  assert.match(error ?? "", /Invalid base URL/);
}

runTests();
