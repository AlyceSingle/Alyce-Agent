import assert from "node:assert/strict";
import { buildConnectionConfigState } from "../../config/runtime.js";
import { getRuntimePaths } from "../../config/runtime.js";
import { buildProviderRegistry } from "./registry.js";
import { formatModelRef, parseModelRef, resolveModelProfile } from "./resolveModel.js";

function runTests() {
  testParsesBareAndProviderModelRefs();
  testLegacyConnectionBuildsDefaultOpenAIProfile();
  testConfiguredProviderDoesNotSwitchCurrentModel();
  testResolvesConfiguredProviderModelProfile();
  testConfiguredProviderProfileWinsOverLegacyEnvironment();
  testUserProviderProfilePartiallyOverridesProjectProviderProfile();
  testProviderModelContextOverrideWinsOverBareOverride();
  testBuiltInOpenAICompatiblePresetsResolve();
  testInvalidConfiguredModelDoesNotBreakProviderRegistry();
  console.log("provider resolveModel tests passed");
}

function testParsesBareAndProviderModelRefs() {
  assert.deepEqual(parseModelRef("gpt-5.2"), {
    providerId: "openai",
    modelId: "gpt-5.2"
  });
  assert.deepEqual(parseModelRef("local/qwen"), {
    providerId: "local",
    modelId: "qwen"
  });
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude-sonnet-4.6"), {
    providerId: "openrouter",
    modelId: "anthropic/claude-sonnet-4.6"
  });
  assert.deepEqual(parseModelRef("OpenAI/gpt-5.2"), {
    providerId: "openai",
    modelId: "gpt-5.2"
  });
  assert.equal(formatModelRef({ providerId: "openai", modelId: "gpt-5.2" }), "openai/gpt-5.2");
}

function testLegacyConnectionBuildsDefaultOpenAIProfile() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    env: {
      apiKey: "env-key",
      baseURL: "https://proxy.example/v1",
      model: "gpt-5.2"
    }
  });
  const resolved = resolveModelProfile(state.effective.model, {
    providers: state.providerProfiles
  });

  assert.deepEqual(state.effective, {
    apiKey: "env-key",
    baseURL: "https://proxy.example/v1",
    model: "gpt-5.2"
  });
  assert.equal(resolved.providerId, "openai");
  assert.equal(resolved.modelId, "gpt-5.2");
  assert.equal(resolved.kind, "openai-compatible");
  assert.equal(resolved.apiKey, "env-key");
  assert.equal(resolved.baseURL, "https://proxy.example/v1");
}

function testConfiguredProviderDoesNotSwitchCurrentModel() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    env: {
      apiKey: "env-key",
      model: "gpt-4.1-mini"
    },
    user: {
      providers: {
        local: {
          label: "Local Qwen",
          kind: "local",
          baseURL: "http://127.0.0.1:11434/v1",
          defaultModel: "qwen",
          models: {
            qwen: {
              contextWindow: 256_000
            }
          }
        }
      }
    }
  });
  const registry = buildProviderRegistry({
    connection: state.effective,
    configuredProviders: state.user.providers
  });

  assert.deepEqual(registry.currentModelRef, {
    providerId: "openai",
    modelId: "gpt-4.1-mini"
  });
  assert.equal(registry.providers.local?.defaultModel, "qwen");
}

function testResolvesConfiguredProviderModelProfile() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      model: "local/qwen",
      providers: {
        local: {
          label: "Local Qwen",
          kind: "local",
          baseURL: "http://127.0.0.1:11434/v1",
          defaultModel: "qwen",
          models: {
            qwen: {
              label: "Qwen Local",
              contextWindow: 256_000,
              maxOutputTokens: 16_384
            }
          }
        }
      }
    }
  });
  const resolved = resolveModelProfile(state.effective.model, {
    providers: state.providerProfiles
  });

  assert.equal(resolved.providerId, "local");
  assert.equal(resolved.modelId, "qwen");
  assert.equal(resolved.label, "Qwen Local");
  assert.equal(resolved.kind, "local");
  assert.equal(resolved.baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(resolved.contextWindow, 256_000);
  assert.equal(resolved.contextWindowSource, "provider_profile");
  assert.equal(resolved.maxOutputTokens, 16_384);
}

function testConfiguredProviderProfileWinsOverLegacyEnvironment() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    env: {
      apiKey: "env-key",
      model: "openai/custom-model"
    },
    user: {
      providers: {
        openai: {
          label: "Profile OpenAI",
          kind: "openai-compatible",
          apiKey: "profile-key",
          baseURL: "https://profile.example/v1",
          models: {
            "custom-model": {
              contextWindow: 321_000
            }
          }
        }
      }
    }
  });
  const resolved = resolveModelProfile(state.effective.model, {
    providers: state.providerProfiles
  });

  assert.equal(resolved.providerId, "openai");
  assert.equal(resolved.kind, "openai-compatible");
  assert.equal(resolved.provider.label, "Profile OpenAI");
  assert.equal(resolved.apiKey, "profile-key");
  assert.equal(resolved.baseURL, "https://profile.example/v1");
  assert.equal(resolved.contextWindow, 321_000);
  assert.equal(resolved.contextWindowSource, "provider_profile");
}

function testUserProviderProfilePartiallyOverridesProjectProviderProfile() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    project: {
      model: "openai/custom-model",
      providers: {
        openai: {
          kind: "openai-compatible",
          baseURL: "https://project.example/v1",
          defaultModel: "custom-model",
          models: {
            "custom-model": {
              contextWindow: 456_000
            }
          }
        }
      }
    },
    user: {
      providers: {
        openai: {
          apiKey: "user-key"
        }
      }
    }
  });
  const resolved = resolveModelProfile(state.effective.model, {
    providers: state.providerProfiles
  });

  assert.equal(resolved.kind, "openai-compatible");
  assert.equal(resolved.apiKey, "user-key");
  assert.equal(resolved.baseURL, "https://project.example/v1");
  assert.equal(resolved.provider.defaultModel, "custom-model");
  assert.equal(resolved.contextWindow, 456_000);
}

function testProviderModelContextOverrideWinsOverBareOverride() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    env: {
      apiKey: "env-key",
      model: "openai/gpt-5.2"
    }
  });
  const resolved = resolveModelProfile(state.effective.model, {
    providers: state.providerProfiles,
    modelContextWindowOverrides: {
      "gpt-5.2": 111_000,
      "openai/gpt-5.2": 222_000
    }
  });

  assert.equal(resolved.providerId, "openai");
  assert.equal(resolved.modelId, "gpt-5.2");
  assert.equal(resolved.contextWindow, 222_000);
  assert.equal(resolved.contextWindowSource, "override");
  assert.equal(resolved.contextWindowMatchedPattern, "openai/gpt-5.2");
}

function testBuiltInOpenAICompatiblePresetsResolve() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      model: "deepseek/deepseek-chat"
    }
  });
  const resolved = resolveModelProfile(state.effective.model, {
    providers: state.providerProfiles,
    env: {
      DEEPSEEK_API_KEY: "deepseek-key"
    }
  });

  assert.equal(resolved.providerId, "deepseek");
  assert.equal(resolved.kind, "openai-compatible");
  assert.equal(resolved.apiKey, "deepseek-key");
  assert.equal(resolved.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(resolved.baseURL, "https://api.deepseek.com/v1");
  assert.equal(resolved.contextWindow, 64_000);
}

function testInvalidConfiguredModelDoesNotBreakProviderRegistry() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      apiKey: "key",
      model: "bad/"
    }
  });
  const registry = buildProviderRegistry({
    connection: state.effective,
    configuredProviders: state.user.providers
  });

  assert.equal(state.effective.model, "bad/");
  assert.equal(registry.currentModelRef.providerId, "openai");
  assert.equal(registry.currentModelRef.modelId, "gpt-4.1-mini");
  assert.ok(state.providerProfiles.openai);
}

runTests();
