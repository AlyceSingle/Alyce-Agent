import assert from "node:assert/strict";
import { buildConnectionConfigState, getRuntimePaths, type SessionSettings } from "../config/runtime.js";
import { applyProviderAuthRecords } from "../core/auth/authStore.js";
import type { ProviderProfileInputMap } from "../core/providers/registry.js";
import {
  formatCurrentModelDisplay,
  formatModelStatusReport,
  isConnectionStateReady,
  resolveModelSwitch
} from "./modelCommand.js";

function runTests() {
  testFormatsBareCurrentModelAsProviderModel();
  testBareSwitchUsesCurrentProvider();
  testOpenAISwitchKeepsBareModelPersistence();
  testUnknownProviderReportsCandidates();
  testUnavailableProviderDoesNotSwitch();
  testModelStatusReportListsProviders();
  testModelStatusReportListsPresetFixHint();
  testModelStatusReportShowsAuthStoreWithoutLeakingKey();
  testConnectionReadinessUsesResolvedProvider();
  testInvalidModelInputReturnsError();
  testInvalidCurrentModelDoesNotCrashStatusReport();
  console.log("modelCommand tests passed");
}

function testFormatsBareCurrentModelAsProviderModel() {
  assert.equal(formatCurrentModelDisplay("gpt-5.2"), "openai/gpt-5.2");
}

function testBareSwitchUsesCurrentProvider() {
  const state = createConnectionState({
    model: "openrouter/openai/gpt-5.2",
    apiKey: "legacy-key",
    providers: {
      openrouter: {
        kind: "openrouter",
        apiKey: "router-key",
        baseURL: "https://openrouter.ai/api/v1",
        models: {
          "openai/gpt-5.2": {},
          "anthropic/claude-sonnet-4.6": {}
        }
      }
    }
  });

  const result = resolveModelSwitch("gpt-5.2", {
    currentModel: state.effective.model,
    providers: state.providerProfiles,
    settings: createSettings()
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.persistModel : "", "openrouter/gpt-5.2");
  assert.equal(result.ok ? result.displayModel : "", "openrouter/gpt-5.2");
}

function testOpenAISwitchKeepsBareModelPersistence() {
  const state = createConnectionState({
    model: "gpt-4.1-mini",
    apiKey: "key"
  });
  const result = resolveModelSwitch("gpt-5.2", {
    currentModel: state.effective.model,
    providers: state.providerProfiles,
    settings: createSettings()
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.persistModel : "", "gpt-5.2");
  assert.equal(result.ok ? result.displayModel : "", "openai/gpt-5.2");
}

function testUnknownProviderReportsCandidates() {
  const state = createConnectionState({
    model: "gpt-4.1-mini",
    apiKey: "key"
  });
  const result = resolveModelSwitch("unknown/model", {
    currentModel: state.effective.model,
    providers: state.providerProfiles,
    settings: createSettings()
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /Unknown provider/);
  assert.match(result.ok ? "" : result.suggestions.join("\n"), /openai/);
}

function testUnavailableProviderDoesNotSwitch() {
  const state = createConnectionState({
    model: "gpt-4.1-mini",
    apiKey: "key"
  });
  const result = resolveModelSwitch("anthropic/claude-sonnet-4.6", {
    currentModel: state.effective.model,
    providers: state.providerProfiles,
    settings: createSettings()
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /ANTHROPIC_API_KEY/);
}

function testModelStatusReportListsProviders() {
  const state = createConnectionState({
    model: "gpt-4.1-mini",
    apiKey: "key"
  });
  const report = formatModelStatusReport({
    connectionState: state,
    settings: createSettings(),
    currentModel: state.effective.model
  });

  assert.match(report, /Current model/);
  assert.match(report, /openai\/gpt-4\.1-mini/);
  assert.match(report, /Providers/);
  assert.match(report, /Switch examples/);
}

function testModelStatusReportListsPresetFixHint() {
  const state = createConnectionState({
    model: "deepseek/deepseek-chat"
  });
  const report = formatModelStatusReport({
    connectionState: state,
    settings: createSettings(),
    currentModel: state.effective.model,
    env: {}
  });

  assert.match(report, /deepseek current: DeepSeek/);
  assert.match(report, /auth: missing DEEPSEEK_API_KEY/);
  assert.match(report, /Configure apiKey or set DEEPSEEK_API_KEY/);
}

function testModelStatusReportShowsAuthStoreWithoutLeakingKey() {
  const authRecords = {
    openrouter: {
      type: "api" as const,
      apiKey: "secret-router-key",
      updatedAt: new Date(0).toISOString()
    }
  };
  const state = createConnectionState({
    model: "openrouter/openai/gpt-5.2",
    providers: {
      openrouter: {
        kind: "openrouter",
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseURL: "https://openrouter.ai/api/v1",
        defaultModel: "openai/gpt-5.2",
        models: {
          "openai/gpt-5.2": {}
        }
      }
    }
  });
  const report = formatModelStatusReport({
    connectionState: {
      ...state,
      providerProfiles: applyProviderAuthRecords(state.providerProfiles, authRecords)
    },
    settings: createSettings(),
    currentModel: state.effective.model,
    authRecords
  });

  assert.match(report, /auth: AuthStore/);
  assert.doesNotMatch(report, /secret-router-key/);
}

function testConnectionReadinessUsesResolvedProvider() {
  const localState = createConnectionState({
    model: "local/local-model",
    providers: {
      local: {
        kind: "local",
        baseURL: "http://127.0.0.1:11434/v1",
        defaultModel: "local-model",
        models: {
          "local-model": {}
        }
      }
    }
  });
  const missingKeyState = createConnectionState({
    model: "openrouter/openai/gpt-5.2",
    providers: {
      openrouter: {
        kind: "openrouter",
        apiKeyEnv: "MISSING_OPENROUTER_KEY",
        baseURL: "https://openrouter.ai/api/v1",
        defaultModel: "openai/gpt-5.2",
        models: {
          "openai/gpt-5.2": {}
        }
      }
    }
  });

  assert.equal(isConnectionStateReady(localState, {}), true);
  assert.equal(isConnectionStateReady(missingKeyState, {}), false);
}

function testInvalidModelInputReturnsError() {
  const state = createConnectionState({
    model: "gpt-4.1-mini",
    apiKey: "key"
  });

  const invalidInput = resolveModelSwitch("openrouter/", {
    currentModel: state.effective.model,
    providers: state.providerProfiles,
    settings: createSettings()
  });
  const invalidCurrent = resolveModelSwitch("gpt-5.2", {
    currentModel: "bad/",
    providers: state.providerProfiles,
    settings: createSettings()
  });

  assert.equal(invalidInput.ok, false);
  assert.match(invalidInput.ok ? "" : invalidInput.message, /Invalid model reference/);
  assert.equal(invalidCurrent.ok, false);
  assert.match(invalidCurrent.ok ? "" : invalidCurrent.message, /Current model is invalid/);
}

function testInvalidCurrentModelDoesNotCrashStatusReport() {
  const state = createConnectionState({
    model: "gpt-4.1-mini",
    apiKey: "key"
  });

  const report = formatModelStatusReport({
    connectionState: state,
    settings: createSettings(),
    currentModel: "bad/"
  });

  assert.match(report, /Current model/);
  assert.match(report, /Invalid model reference/);
  assert.match(report, /Providers/);
}

function createConnectionState(input: {
  model: string;
  apiKey?: string;
  providers?: ProviderProfileInputMap;
}) {
  return buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      apiKey: input.apiKey,
      model: input.model,
      providers: input.providers
    }
  });
}

function createSettings(): Pick<SessionSettings, "modelContextWindowOverrides"> {
  return {
    modelContextWindowOverrides: {}
  };
}

runTests();
