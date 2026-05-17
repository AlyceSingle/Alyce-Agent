import assert from "node:assert/strict";
import type { SessionSettingsState } from "../../config/runtime.js";
import type { BackgroundProcessRecord } from "../../core/background-process/backgroundProcessTypes.js";
import { createInitialTerminalUiState } from "../state/actions.js";
import { createTerminalUiStore } from "../state/store.js";
import type { TerminalUiMessage } from "../state/types.js";
import type { SessionRuntime } from "../../cli/sessionRuntime.js";
import { __SESSION_CONTROLLER_TESTING__, createSessionController } from "./sessionController.js";

async function runTests() {
  testMergeThinkingContentSkipsWhitespaceChunk();
  testMergeThinkingContentAcceptsInitialChunk();
  testMergeThinkingContentPrefersCumulativeSnapshot();
  testMergeThinkingContentAppendsDeltaChunkWithoutLosingWhitespace();
  testMergeThinkingContentAvoidsDuplicateTailDelta();
  testMergeThinkingContentAppendsOnlyNonOverlappingSuffix();
  testExtractThinkingDeltaForInitialSnapshot();
  testExtractThinkingDeltaForSuffixGrowth();
  testExtractThinkingDeltaForUnchangedSnapshot();
  testExtractThinkingDeltaForOverlap();
  testShouldSkipApprovalDialog();
  testBuildApprovalModePermissionRules();
  testBackgroundPanelOnlyShowsRunningNonAutoReviewerTasks();
  testBackgroundProcessCountOnlyIncludesRunningProcesses();
  testParseAutoReviewDecision();
  await testSettingsCommandOpensSessionSettings();
  await testConnectCommandOpensInteractiveDialog();
  await testModelCommandOpensInteractiveDialog();
  await testConnectDialogSubmissionAppliesProviderConnection();
  await testConnectDialogOAuthFlowAppliesProviderAuth();
  testConnectDialogCancelClearsPendingProviderAuth();
  await testModelDialogSelectionSwitchesModel();
  await testProcessCommandsRouteThroughController();
  await testWaitForUiPaintYieldsToMacrotask();
  console.log("sessionController tests passed");
}

function testMergeThinkingContentSkipsWhitespaceChunk() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", "   ");
  assert.equal(merged, "hello");
}

function testMergeThinkingContentAcceptsInitialChunk() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("", "hello");
  assert.equal(merged, "hello");
}

function testMergeThinkingContentPrefersCumulativeSnapshot() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", "hello world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAppendsDeltaChunkWithoutLosingWhitespace() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", " world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAvoidsDuplicateTailDelta() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello world", " world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAppendsOnlyNonOverlappingSuffix() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent(
    "The quick brown f",
    "fox jumps"
  );
  assert.equal(merged, "The quick brown fox jumps");
}

function testExtractThinkingDeltaForInitialSnapshot() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("", "hello");
  assert.equal(delta, "hello");
}

function testExtractThinkingDeltaForSuffixGrowth() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("hello", "hello world");
  assert.equal(delta, " world");
}

function testExtractThinkingDeltaForUnchangedSnapshot() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("hello", "hello");
  assert.equal(delta, "");
}

function testExtractThinkingDeltaForOverlap() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("The quick brown f", "fox jumps");
  assert.equal(delta, "ox jumps");
}

function testShouldSkipApprovalDialog() {
  const shouldSkip = __SESSION_CONTROLLER_TESTING__.shouldSkipApprovalDialog;

  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: false }, "default"), true);
  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: true }, "default"), false);
  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: true }, "full-access"), true);
  assert.equal(shouldSkip(null, { forceAsk: true }, "full-access"), true);
  assert.equal(shouldSkip({ action: "deny" }, { forceAsk: false }, "full-access"), false);
}

function testBuildApprovalModePermissionRules() {
  const rules = __SESSION_CONTROLLER_TESTING__.buildApprovalModePermissionRules;

  assert.deepEqual(rules("read-only"), []);
  assert.deepEqual(
    rules("default").map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`),
    [
      "file.write:workspace:*:allow",
      "file.edit:workspace:*:allow",
      "file.patch:workspace:*:allow",
      "shell:*:allow",
      "powershell:*:allow"
    ]
  );
  assert.deepEqual(
    rules("auto-review").map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`),
    [
      "file.write:workspace:*:allow",
      "file.edit:workspace:*:allow",
      "file.patch:workspace:*:allow",
      "shell:*:allow",
      "powershell:*:allow"
    ]
  );
  assert.deepEqual(
    rules("full-access").map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`),
    ["*:*:allow"]
  );
}

function testBackgroundPanelOnlyShowsRunningNonAutoReviewerTasks() {
  const isVisible = __SESSION_CONTROLLER_TESTING__.isVisibleBackgroundTask;

  assert.equal(isVisible({ agentType: "auto-reviewer", status: "running" }), false);
  assert.equal(isVisible({ agentType: "review", status: "running" }), true);
  assert.equal(isVisible({ agentType: "general", status: "running" }), true);
  assert.equal(isVisible({ agentType: "review", status: "completed" }), false);
  assert.equal(isVisible({ agentType: "review", status: "failed" }), false);
  assert.equal(isVisible({ agentType: "review", status: "stopped" }), false);
}

function testBackgroundProcessCountOnlyIncludesRunningProcesses() {
  const isVisible = __SESSION_CONTROLLER_TESTING__.isVisibleBackgroundProcess;

  assert.equal(isVisible({ status: "running" }), true);
  assert.equal(isVisible({ status: "starting" }), false);
  assert.equal(isVisible({ status: "exited" }), false);
  assert.equal(isVisible({ status: "failed" }), false);
  assert.equal(isVisible({ status: "stopped" }), false);
}

function testParseAutoReviewDecision() {
  const parse = __SESSION_CONTROLLER_TESTING__.parseAutoReviewDecision;

  assert.deepEqual(
    parse('{"decision":"approve","confidence":0.9,"reason":"Scoped request."}'),
    {
      decision: "approve",
      confidence: 0.9,
      reason: "Scoped request."
    }
  );
  assert.deepEqual(
    parse('```json\n{"decision":"reject","confidence":2,"reason":"Too broad."}\n```'),
    {
      decision: "reject",
      confidence: 1,
      reason: "Too broad."
    }
  );
  assert.equal(parse('{"decision":"maybe","confidence":0.9}'), null);
  assert.equal(parse("not json"), null);
}

async function testSettingsCommandOpensSessionSettings() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/settings");

  const dialog = store.getState().dialogQueue[0];
  assert.equal(dialog?.type, "settings");
  assert.equal(dialog?.type === "settings" ? dialog.section : "", "session");
}

async function testConnectCommandOpensInteractiveDialog() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/connect");

  assert.equal(store.getState().dialogQueue[0]?.type, "connect-provider");
}

async function testModelCommandOpensInteractiveDialog() {
  let refreshCalled = false;
  const runtime = createRuntimeStub({
    refreshCurrentProviderModels: async () => {
      refreshCalled = true;
      return {
        providerId: "openai",
        providerLabel: "OpenAI",
        models: {
          "gpt-live": { label: "GPT Live" }
        },
        source: "live"
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/model");

  const dialog = store.getState().dialogQueue[0];
  assert.equal(refreshCalled, true);
  assert.equal(dialog?.type, "model-picker");
  assert.equal(dialog?.type === "model-picker" ? dialog.state.status : "", "ready");
  assert.equal(dialog?.type === "model-picker" ? dialog.state.source : "", "live");
}

async function testConnectDialogSubmissionAppliesProviderConnection() {
  let connectionState = createInitialState().connectionState;
  let appliedProviderId = "";
  const runtime = createRuntimeStub({
    getConnectionConfigState: () => connectionState,
    applyProviderConnection: async (plan) => {
      appliedProviderId = plan.providerId;
      connectionState = {
        ...connectionState,
        effective: {
          ...connectionState.effective,
          model: plan.model
        },
        providerProfiles: {
          ...connectionState.providerProfiles,
          [plan.providerId]: {
            ...connectionState.providerProfiles[plan.providerId]!,
            ...(plan.apiKey ? { apiKey: plan.apiKey } : {})
          }
        }
      };
    },
    getAuthStorePath: () => "C:\\Users\\Single\\.alyce\\auth.json"
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);
  await controller.submit("/connect");

  const result = await controller.connectProviderFromDialog("openrouter", ["router-key"]);

  assert.equal(result.ok, true);
  assert.equal(appliedProviderId, "openrouter");
  assert.equal(store.getState().dialogQueue.length, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Connected OpenRouter/);
  assert.doesNotMatch(lastMessage(store.getState().messages)?.content ?? "", /router-key/);
}

async function testConnectDialogOAuthFlowAppliesProviderAuth() {
  let completed = false;
  const runtime = createRuntimeStub({
    authorizeProviderAuth: async () => ({
      type: "flow",
      flow: {
        method: "auto",
        url: "https://github.com/login/device",
        instructions: "Enter code: ABCD-1234",
        callback: async () => ({
          type: "oauth",
          accessToken: "secret-token"
        })
      }
    }),
    completeProviderAuth: async (providerId) => {
      completed = true;
      return {
        providerId,
        model: `${providerId}/gpt-5.2`
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);
  await controller.submit("/connect");

  const started = await controller.authorizeProviderAuthFromDialog("github-copilot", 0, {
    deploymentType: "github.com"
  });
  const finished = await controller.completeProviderAuthFromDialog("github-copilot", 0);

  assert.equal(started.ok, true);
  assert.equal(started.ok ? started.type : "", "flow");
  assert.equal(finished.ok, true);
  assert.equal(completed, true);
  assert.equal(store.getState().dialogQueue.length, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Connected github-copilot/);
  assert.doesNotMatch(lastMessage(store.getState().messages)?.content ?? "", /secret-token/);
}

function testConnectDialogCancelClearsPendingProviderAuth() {
  let clearedProvider = "";
  const runtime = createRuntimeStub({
    clearProviderAuthFlow: (providerId) => {
      clearedProvider = providerId ?? "";
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  controller.cancelProviderAuthFromDialog("github-copilot", 0);

  assert.equal(clearedProvider, "github-copilot");
}

async function testModelDialogSelectionSwitchesModel() {
  let connectionState = {
    ...createInitialState().connectionState,
    effective: {
      apiKey: "key",
      baseURL: "https://api.githubcopilot.com",
      model: "github-copilot/gpt-5.2"
    },
    providerProfiles: {
      "github-copilot": {
        id: "github-copilot",
        label: "GitHub Copilot",
        kind: "openai-compatible" as const,
        apiKey: "copilot-token",
        baseURL: "https://api.githubcopilot.com",
        defaultModel: "gpt-5.2",
        models: {
          "gpt-5.2": {},
          "claude-sonnet-4.5": {}
        }
      }
    }
  };
  let selectedModel = "";
  const runtime = createRuntimeStub({
    getConnectionConfigState: () => connectionState,
    getCurrentModel: () => connectionState.effective.model,
    setCurrentModel: async (model) => {
      selectedModel = model;
      connectionState = {
        ...connectionState,
        effective: {
          ...connectionState.effective,
          model
        }
      };
    }
  });
  const store = createTerminalUiStore({
    ...createInitialState(),
    connectionState,
    connection: connectionState.effective
  });
  const controller = createSessionController(runtime, store);
  await controller.submit("/model");

  const result = await controller.switchModelFromDialog("github-copilot/claude-sonnet-4.5");

  assert.equal(result.ok, true);
  assert.equal(selectedModel, "github-copilot/claude-sonnet-4.5");
  assert.equal(store.getState().dialogQueue.length, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Switched model to: github-copilot\/claude-sonnet-4\.5/);
}

async function testProcessCommandsRouteThroughController() {
  const runningProcess = createBackgroundProcessRecord({ status: "running" });
  const startingProcess = createBackgroundProcessRecord({ id: "bg_starting", status: "starting" });
  const exitedProcess = createBackgroundProcessRecord({ id: "bg_exited", status: "exited" });
  const failedProcess = createBackgroundProcessRecord({ id: "bg_failed", status: "failed" });
  const stoppedProcess = createBackgroundProcessRecord({ status: "stopped" });
  let processes: BackgroundProcessRecord[] = [
    runningProcess,
    startingProcess,
    exitedProcess,
    failedProcess,
    stoppedProcess
  ];
  let stoppedProcessId = "";
  const runtime = createRuntimeStub({
    listBackgroundProcesses: () => processes,
    stopBackgroundProcess: async (processId) => {
      stoppedProcessId = processId;
      processes = [];
      return {
        processId,
        status: "stopped",
        message: `Background process ${processId} stopped.`,
        record: stoppedProcess
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/processes");
  assert.equal(store.getState().backgroundProcessCount, 1);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Background Processes/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /bg_test/);

  await controller.submit("/stop bg_test");
  assert.equal(stoppedProcessId, "bg_test");
  assert.equal(store.getState().backgroundProcessCount, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Status: stopped/);
}

async function testWaitForUiPaintYieldsToMacrotask() {
  let settled = false;
  const paintPromise = __SESSION_CONTROLLER_TESTING__.waitForUiPaint().then(() => {
    settled = true;
  });

  assert.equal(settled, false);
  await Promise.resolve();
  assert.equal(settled, false);

  await paintPromise;
  assert.equal(settled, true);
}

function createRuntimeStub(overrides: Partial<{
  getCurrentModel: SessionRuntime["getCurrentModel"];
  getResolvedModelProfile: SessionRuntime["getResolvedModelProfile"];
  getConnectionConfigState: SessionRuntime["getConnectionConfigState"];
  refreshCurrentProviderModels: SessionRuntime["refreshCurrentProviderModels"];
  setCurrentModel: SessionRuntime["setCurrentModel"];
  applyProviderConnection: SessionRuntime["applyProviderConnection"];
  authorizeProviderAuth: SessionRuntime["authorizeProviderAuth"];
  completeProviderAuth: SessionRuntime["completeProviderAuth"];
  clearProviderAuthFlow: SessionRuntime["clearProviderAuthFlow"];
  getAuthStorePath: SessionRuntime["getAuthStorePath"];
  listBackgroundProcesses: SessionRuntime["listBackgroundProcesses"];
  stopBackgroundProcess: SessionRuntime["stopBackgroundProcess"];
}>): SessionRuntime {
  const settings = createSettingsState().effective;
  const connectionState = createInitialState().connectionState;
  return {
    getSettings: () => settings,
    getPlanModeState: () => ({ enabled: false }),
    getCurrentModel: overrides.getCurrentModel ?? (() => connectionState.effective.model),
    getResolvedModelProfile: overrides.getResolvedModelProfile ?? (() => ({
      providerId: "openai",
      modelId: "gpt-5.2",
      modelRef: { providerId: "openai", modelId: "gpt-5.2" },
      label: "gpt-5.2",
      provider: {
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        apiKey: "key",
        baseURL: "https://api.openai.com/v1"
      },
      kind: "openai",
      apiKey: "key",
      baseURL: "https://api.openai.com/v1",
      contextWindow: 400_000,
      contextWindowSource: "fallback",
      contextWindowLabel: "fallback"
    })),
    getConnectionConfigState: overrides.getConnectionConfigState ?? (() => connectionState),
    refreshCurrentProviderModels: overrides.refreshCurrentProviderModels ?? (async () => ({
      providerId: "openai",
      providerLabel: "OpenAI",
      models: {},
      source: "fallback"
    })),
    setCurrentModel: overrides.setCurrentModel ?? (async () => undefined),
    getProviderAuthRecords: () => ({}),
    applyProviderConnection: overrides.applyProviderConnection ?? (async () => undefined),
    authorizeProviderAuth: overrides.authorizeProviderAuth ?? (async (providerId) => ({
      type: "stored",
      providerId,
      model: `${providerId}/model`
    })),
    completeProviderAuth: overrides.completeProviderAuth ?? (async (providerId) => ({
      providerId,
      model: `${providerId}/model`
    })),
    clearProviderAuthFlow: overrides.clearProviderAuthFlow ?? (() => undefined),
    getAuthStorePath: overrides.getAuthStorePath ?? (() => "C:\\Users\\Single\\.alyce\\auth.json"),
    listSubagentTasks: () => [],
    listBackgroundProcesses: overrides.listBackgroundProcesses ?? (() => []),
    stopBackgroundProcess: overrides.stopBackgroundProcess ?? (async () => ({
      processId: "bg_test",
      status: "not_found",
      message: "Background process not found."
    })),
    stopAllBackgroundProcesses: async () => [],
    listPtySessions: () => [],
    closeAllPtySessions: () => [],
    flushSessionHistory: async () => undefined
  } as unknown as SessionRuntime;
}

function createBackgroundProcessRecord(
  overrides: Partial<BackgroundProcessRecord> = {}
): BackgroundProcessRecord {
  return {
    id: "bg_test",
    command: "npm run dev",
    cwd: "C:\\workspace",
    pid: 12345,
    status: "running",
    startedAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:01.000Z",
    stdoutLogPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\stdout.log",
    stderrLogPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\stderr.log",
    combinedLogPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\output.log",
    recordPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\process.json",
    stdoutPreview: "Local: http://localhost:5173/",
    stderrPreview: "",
    detectedUrls: ["http://localhost:5173/"],
    detectedPorts: [5173],
    warnings: [],
    ...overrides
  };
}

function createInitialState() {
  const settingsState = createSettingsState();
  return createInitialTerminalUiState({
    connectionState: {
      effective: { apiKey: "key", baseURL: "https://example.com", model: "gpt-5.2" },
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
    settingsState,
    workspaceRoot: "C:\\workspace",
    requestPatchCount: 0
  });
}

function createSettingsState(): SessionSettingsState {
  return {
    effective: {
      approvalMode: "default",
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

function lastMessage(messages: readonly TerminalUiMessage[]): TerminalUiMessage | undefined {
  return messages.at(-1);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
