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

  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: false }, false), true);
  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: true }, false), false);
  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: true }, true), true);
  assert.equal(shouldSkip(null, { forceAsk: true }, true), true);
  assert.equal(shouldSkip({ action: "deny" }, { forceAsk: false }, true), false);
}

async function testProcessCommandsRouteThroughController() {
  const runningProcess = createBackgroundProcessRecord({ status: "running" });
  const stoppedProcess = createBackgroundProcessRecord({ status: "stopped" });
  let processes: BackgroundProcessRecord[] = [runningProcess];
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

function createRuntimeStub(overrides: {
  listBackgroundProcesses: SessionRuntime["listBackgroundProcesses"];
  stopBackgroundProcess: SessionRuntime["stopBackgroundProcess"];
}): SessionRuntime {
  const settings = createSettingsState().effective;
  return {
    getSettings: () => settings,
    getPlanModeState: () => ({ enabled: false }),
    listSubagentTasks: () => [],
    listBackgroundProcesses: overrides.listBackgroundProcesses,
    stopBackgroundProcess: overrides.stopBackgroundProcess,
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
