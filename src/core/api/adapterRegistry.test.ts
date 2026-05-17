import assert from "node:assert/strict";
import { resolveModelAdapterFactory } from "./adapterRegistry.js";
import type { ResolvedModelProfile } from "../providers/types.js";

function runTests() {
  testAnthropicWithoutBaseUrlUsesNativeFactory();
  testGoogleWithoutBaseUrlUsesNativeFactory();
  testAnthropicWithBaseUrlFallsBackToCompatibleFactory();
  testOpenRouterUsesCompatibleFactory();
  console.log("adapter registry tests passed");
}

function testAnthropicWithoutBaseUrlUsesNativeFactory() {
  assert.equal(resolveModelAdapterFactory(createResolvedModel("anthropic")).id, "anthropic-native");
}

function testGoogleWithoutBaseUrlUsesNativeFactory() {
  assert.equal(resolveModelAdapterFactory(createResolvedModel("google")).id, "google-native");
}

function testAnthropicWithBaseUrlFallsBackToCompatibleFactory() {
  assert.equal(
    resolveModelAdapterFactory(createResolvedModel("anthropic", "https://gateway.example/v1")).id,
    "openai-compatible"
  );
}

function testOpenRouterUsesCompatibleFactory() {
  assert.equal(
    resolveModelAdapterFactory(createResolvedModel("openrouter", "https://openrouter.ai/api/v1")).id,
    "openai-compatible"
  );
}

function createResolvedModel(
  kind: ResolvedModelProfile["kind"],
  baseURL?: string
): ResolvedModelProfile {
  return {
    providerId: kind,
    modelId: "model",
    modelRef: { providerId: kind, modelId: "model" },
    label: "model",
    provider: {
      id: kind,
      label: kind,
      kind,
      ...(baseURL ? { baseURL } : {})
    },
    kind,
    apiKey: "test-key",
    ...(baseURL ? { baseURL } : {}),
    contextWindow: 128_000,
    contextWindowSource: "fallback",
    contextWindowLabel: "fallback"
  };
}

runTests();
