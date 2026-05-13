import assert from "node:assert/strict";
import type { SessionSettingsState } from "../../config/runtime.js";
import {
  createInitialTerminalUiState,
  prependMessages,
  setPlanModeEnabled,
  setSessionFullApprovalEnabled
} from "./actions.js";
import type { TerminalUiMessage } from "./types.js";

function createMessage(id: string): TerminalUiMessage {
  return {
    id,
    kind: "assistant",
    title: id,
    blocks: [{ content: id }],
    content: id,
    preview: id,
    metadata: [],
    createdAt: "2026-05-01T00:00:00.000Z"
  };
}

function createSettingsState(): SessionSettingsState {
  return {
    effective: {
      approvalMode: "manual",
      maxSteps: 50,
      commandTimeoutMs: 120_000,
      scrollSpeed: 2,
      scrollAccelerationEnabled: false,
      historyPagingEnabled: false,
      maxMessagesWithoutVirtualization: 200,
      sessionMemoryEnabled: true,
      messageTimestampsEnabled: false,
      markdownMessageRenderingEnabled: true,
      markdownToolMessageRenderingEnabled: true,
      markdownRenderMaxChars: 32_000,
      diagnosticsPendingTimeoutMs: 120_000,
      diagnosticsFailureThreshold: 3,
      diagnosticsFailureCooldownMs: 300_000,
      conversationCompactionEnabled: true,
      autoCompactTimeoutMs: 180_000,
      autoCompactMaxFailures: 3,
      modelContextWindowOverrides: {},
      additionalDirectories: [],
      permissionRules: []
    },
    project: {},
    user: {},
    env: {},
    cli: {},
    sources: {
      approvalMode: "default",
      maxSteps: "default",
      commandTimeoutMs: "default",
      scrollSpeed: "default",
      scrollAccelerationEnabled: "default",
      historyPagingEnabled: "default",
      maxMessagesWithoutVirtualization: "default",
      sessionMemoryEnabled: "default",
      messageTimestampsEnabled: "default",
      markdownMessageRenderingEnabled: "default",
      markdownToolMessageRenderingEnabled: "default",
      markdownRenderMaxChars: "default",
      diagnosticsPendingTimeoutMs: "default",
      diagnosticsFailureThreshold: "default",
      diagnosticsFailureCooldownMs: "default",
      conversationCompactionEnabled: "default",
      autoCompactTimeoutMs: "default",
      autoCompactMaxFailures: "default",
      modelContextWindowOverrides: "default",
      languagePreference: "default",
      personaPreset: "default",
      aiPersonalityPrompt: "default",
      appendSystemPrompt: "default",
      additionalDirectories: "default",
      permissionRules: "default"
    },
    saveTargetPath: "C:\\tmp\\settings.json",
    projectPath: "C:\\tmp\\project-settings.json"
  };
}

function runTests() {
  testInitialStateDisablesPlanMode();
  testSetPlanModeEnabled();
  testInitialStateDisablesFullApproval();
  testSetSessionFullApprovalEnabled();
  testPrependMessagesAddsUniqueMessagesAtTop();
  testPrependMessagesPreservesSelectedMessage();
  console.log("actions tests passed");
}

function createInitialState() {
  return createInitialTerminalUiState({
    connectionState: {
      effective: { apiKey: "key", baseURL: "https://example.com", model: "gpt-4.1-mini" },
      user: {},
      project: {},
      env: {},
      cli: {},
      sources: {
        apiKey: "default",
        baseURL: "default",
        model: "default"
      },
      saveTarget: "user",
      saveTargetPath: "C:\\tmp\\config.json",
      userPath: "C:\\tmp\\user-config.json",
      projectPath: "C:\\tmp\\project-config.json"
    },
    settingsState: createSettingsState(),
    workspaceRoot: "C:\\workspace",
    requestPatchCount: 0
  });
}

function testInitialStateDisablesPlanMode() {
  const initial = createInitialState();

  assert.equal(initial.planModeEnabled, false);
}

function testSetPlanModeEnabled() {
  const initial = createInitialState();
  const next = setPlanModeEnabled(initial, true);

  assert.equal(next.planModeEnabled, true);
  assert.equal(setPlanModeEnabled(next, true), next);
}

function testInitialStateDisablesFullApproval() {
  const initial = createInitialState();

  assert.equal(initial.sessionFullApprovalEnabled, false);
}

function testSetSessionFullApprovalEnabled() {
  const initial = createInitialState();
  const next = setSessionFullApprovalEnabled(initial, true);

  assert.equal(next.sessionFullApprovalEnabled, true);
  assert.equal(setSessionFullApprovalEnabled(next, true), next);
}

function testPrependMessagesAddsUniqueMessagesAtTop() {
  const initial = createInitialState();
  const withMessages = {
    ...initial,
    messages: [createMessage("b"), createMessage("c")]
  };

  const next = prependMessages(withMessages, [createMessage("a"), createMessage("b")]);
  assert.deepEqual(next.messages.map((message) => message.id), ["a", "b", "c"]);
}

function testPrependMessagesPreservesSelectedMessage() {
  const initial = createInitialState();
  const withMessages = {
    ...initial,
    messages: [createMessage("b"), createMessage("c")],
    selectedMessageId: "c"
  };

  const next = prependMessages(withMessages, [createMessage("a")]);
  assert.equal(next.selectedMessageId, "c");
}

runTests();
