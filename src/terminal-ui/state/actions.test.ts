import assert from "node:assert/strict";
import type { SessionSettingsState } from "../../config/runtime.js";
import {
  clearQueuedInputs,
  createInitialTerminalUiState,
  dequeueInput,
  enqueueInput,
  openSettingsDialog,
  openConnectProviderDialog,
  openModelPickerDialog,
  prependMessages,
  setPlanModeEnabled,
  updateModelPickerDialogState
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
      uiLanguage: "en",
      approvalMode: "default",
      maxSteps: 50,
      commandTimeoutMs: 120_000,
      scrollSpeed: 2,
      scrollAccelerationEnabled: false,
      historyPagingEnabled: false,
      maxMessagesWithoutVirtualization: 200,
      sessionMemoryEnabled: true,
      messageTimestampsEnabled: false,
      showMessageTimestamps: false,
      markdownMessageRenderingEnabled: true,
      markdownToolMessageRenderingEnabled: true,
      markdownRenderMaxChars: 32_000,
      thinkingMessagesExpandedByDefault: false,
      diagnosticsPendingTimeoutMs: 120_000,
      diagnosticsFailureThreshold: 3,
      diagnosticsFailureCooldownMs: 300_000,
      snapshot: {
        enabled: true,
        engine: "hybrid",
        maxTextDiffBytes: 524_288,
        maxFileBytes: 2_097_152,
        retentionDays: 7,
        includeIgnoredExplicitPaths: true,
        manifestScan: true
      },
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
      uiLanguage: "default",
      approvalMode: "default",
      maxSteps: "default",
      commandTimeoutMs: "default",
      scrollSpeed: "default",
      scrollAccelerationEnabled: "default",
      historyPagingEnabled: "default",
      maxMessagesWithoutVirtualization: "default",
      sessionMemoryEnabled: "default",
      messageTimestampsEnabled: "default",
      showMessageTimestamps: "default",
      markdownMessageRenderingEnabled: "default",
      markdownToolMessageRenderingEnabled: "default",
      markdownRenderMaxChars: "default",
      thinkingMessagesExpandedByDefault: "default",
      diagnosticsPendingTimeoutMs: "default",
      diagnosticsFailureThreshold: "default",
      diagnosticsFailureCooldownMs: "default",
      snapshot: "default",
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
  testInitialStateUsesConnectionReadyOverride();
  testSetPlanModeEnabled();
  testOpenSettingsDialog();
  testOpenConnectProviderDialog();
  testOpenModelPickerDialog();
  testUpdateModelPickerDialogState();
  testPrependMessagesAddsUniqueMessagesAtTop();
  testPrependMessagesPreservesSelectedMessage();
  testInputQueueStartsEmpty();
  testEnqueueInputPreservesOrder();
  testDequeueInputTakesFromTheFront();
  testClearQueuedInputs();
  console.log("actions tests passed");
}

function testInputQueueStartsEmpty() {
  assert.deepEqual(createInitialState().queuedInputs, []);
}

function testEnqueueInputPreservesOrder() {
  const state = enqueueInput(enqueueInput(createInitialState(), "first"), "second");

  assert.deepEqual(state.queuedInputs, ["first", "second"]);
}

function testDequeueInputTakesFromTheFront() {
  const queued = enqueueInput(enqueueInput(createInitialState(), "first"), "second");
  const afterFirst = dequeueInput(queued);

  assert.deepEqual(afterFirst.queuedInputs, ["second"]);

  const afterSecond = dequeueInput(afterFirst);
  assert.deepEqual(afterSecond.queuedInputs, []);

  // 队列已空时保持同一引用，避免无意义的重渲染。
  assert.equal(dequeueInput(afterSecond), afterSecond);
}

function testClearQueuedInputs() {
  const queued = enqueueInput(createInitialState(), "only");

  assert.deepEqual(clearQueuedInputs(queued).queuedInputs, []);

  const empty = createInitialState();
  assert.equal(clearQueuedInputs(empty), empty);
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
      providerProfiles: {},
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

function testInitialStateUsesConnectionReadyOverride() {
  const ready = createInitialTerminalUiState({
    connectionState: {
      ...createInitialState().connectionState,
      effective: { apiKey: "", model: "local/local-model" }
    },
    settingsState: createSettingsState(),
    workspaceRoot: "C:\\workspace",
    requestPatchCount: 0,
    connectionReady: true
  });
  const unavailable = createInitialTerminalUiState({
    connectionState: {
      ...createInitialState().connectionState,
      effective: { apiKey: "key", model: "local/local-model" }
    },
    settingsState: createSettingsState(),
    workspaceRoot: "C:\\workspace",
    requestPatchCount: 0,
    connectionReady: false
  });

  assert.equal(ready.statusText, "Idle");
  assert.equal(unavailable.statusText, "Setup required");
}

function testSetPlanModeEnabled() {
  const initial = createInitialState();
  const next = setPlanModeEnabled(initial, true);

  assert.equal(next.planModeEnabled, true);
  assert.equal(setPlanModeEnabled(next, true), next);
}

function testOpenSettingsDialog() {
  const initial = createInitialState();
  const next = openSettingsDialog(initial, "from test");

  assert.equal(next.dialogQueue[0]?.type, "settings");
  assert.equal(next.dialogQueue[0]?.layer, "overlay");
  assert.equal(next.dialogQueue[0]?.type === "settings" ? next.dialogQueue[0].reason : "", "from test");
}

function testOpenConnectProviderDialog() {
  const initial = createInitialState();
  const next = openConnectProviderDialog(initial);

  assert.equal(next.dialogQueue[0]?.type, "connect-provider");
  assert.equal(next.dialogQueue[0]?.layer, "modal");
}

function testOpenModelPickerDialog() {
  const initial = createInitialState();
  const next = openModelPickerDialog(initial, {
    status: "loading",
    providerId: "openai",
    providerLabel: "OpenAI"
  });

  assert.equal(next.dialogQueue[0]?.type, "model-picker");
  assert.equal(next.dialogQueue[0]?.layer, "modal");
  assert.equal(next.dialogQueue[0]?.type === "model-picker" ? next.dialogQueue[0].state.status : "", "loading");
}

function testUpdateModelPickerDialogState() {
  const initial = openModelPickerDialog(createInitialState(), {
    status: "loading",
    providerId: "openai",
    providerLabel: "OpenAI"
  });

  const next = updateModelPickerDialogState(initial, {
    status: "ready",
    providerId: "openai",
    providerLabel: "OpenAI",
    source: "live"
  });

  assert.equal(next.dialogQueue[0]?.type === "model-picker" ? next.dialogQueue[0].state.status : "", "ready");
  assert.equal(next.dialogQueue[0]?.type === "model-picker" ? next.dialogQueue[0].state.source : "", "live");
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
