import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  buildSessionSettingsState,
  loadRuntimeConfig,
  saveUserSessionSettings,
  type RuntimePaths
} from "./runtime.js";

async function runTests() {
  testSessionSettingsDefaultsIncludeScrollPerformanceSettings();
  testSessionSettingsClampsScrollSpeed();
  await testRuntimeConfigReadsScrollPerformanceEnv();
  await testRuntimeConfigReadsSnapshotSettingsFromEnv();
  await testRuntimeConfigIgnoresRetiredStatusUsageSetting();
  await testSessionSettingsSerializationIncludesScrollPerformanceSettings();
  console.log("runtime config tests passed");
}

function createPaths(workspaceRoot: string): Pick<
  RuntimePaths,
  "workspaceRoot" | "settingsConfigPath" | "userSettingsConfigPath"
> {
  return {
    workspaceRoot,
    settingsConfigPath: path.join(workspaceRoot, ".alyce", "settings.json"),
    userSettingsConfigPath: path.join(workspaceRoot, "user", "settings.json")
  };
}

function testSessionSettingsDefaultsIncludeScrollPerformanceSettings() {
  const state = buildSessionSettingsState(createPaths("C:\\workspace"), {});

  assert.equal(state.effective.scrollSpeed, 2);
  assert.equal(state.effective.scrollAccelerationEnabled, false);
  assert.equal(state.effective.historyPagingEnabled, false);
  assert.equal(state.effective.maxMessagesWithoutVirtualization, 200);
  assert.equal(state.effective.diagnosticsPendingTimeoutMs, 120_000);
  assert.equal(state.effective.diagnosticsFailureThreshold, 3);
  assert.equal(state.effective.diagnosticsFailureCooldownMs, 300_000);
  assert.deepEqual(state.effective.snapshot, {
    enabled: true,
    engine: "hybrid",
    maxTextDiffBytes: 524_288,
    maxFileBytes: 2_097_152,
    retentionDays: 7,
    includeIgnoredExplicitPaths: true,
    manifestScan: true
  });
  assert.deepEqual(state.effective.permissionRules, []);
}

function testSessionSettingsClampsScrollSpeed() {
  const low = buildSessionSettingsState(createPaths("C:\\workspace"), {
    user: { scrollSpeed: 0 }
  });
  const high = buildSessionSettingsState(createPaths("C:\\workspace"), {
    user: { scrollSpeed: 99 }
  });

  assert.equal(low.effective.scrollSpeed, 1);
  assert.equal(high.effective.scrollSpeed, 8);
}

async function testRuntimeConfigReadsScrollPerformanceEnv() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-"));
  const config = await loadRuntimeConfig([], {
    ...process.env,
    AGENT_WORKSPACE: workspaceRoot,
    AGENT_SCROLL_SPEED: "6",
    AGENT_SCROLL_ACCELERATION_ENABLED: "true",
    AGENT_HISTORY_PAGING_ENABLED: "true",
    AGENT_MAX_MESSAGES_WITHOUT_VIRTUALIZATION: "75",
    AGENT_DIAGNOSTICS_TIMEOUT_MS: "64000",
    AGENT_DIAGNOSTICS_FAILURE_THRESHOLD: "5",
    AGENT_DIAGNOSTICS_FAILURE_COOLDOWN_MS: "90000"
  });

  assert.equal(config.settings.scrollSpeed, 6);
  assert.equal(config.settings.scrollAccelerationEnabled, true);
  assert.equal(config.settings.historyPagingEnabled, true);
  assert.equal(config.settings.maxMessagesWithoutVirtualization, 75);
  assert.equal(config.settings.diagnosticsPendingTimeoutMs, 64_000);
  assert.equal(config.settings.diagnosticsFailureThreshold, 5);
  assert.equal(config.settings.diagnosticsFailureCooldownMs, 90_000);
}

async function testRuntimeConfigReadsSnapshotSettingsFromEnv() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-snapshot-"));
  const config = await loadRuntimeConfig([], {
    ...process.env,
    AGENT_WORKSPACE: workspaceRoot,
    AGENT_SNAPSHOT_ENABLED: "false",
    AGENT_SNAPSHOT_ENGINE: "file-backup",
    AGENT_SNAPSHOT_MAX_TEXT_DIFF_BYTES: "1000",
    AGENT_SNAPSHOT_MAX_FILE_BYTES: "2000",
    AGENT_SNAPSHOT_RETENTION_DAYS: "14",
    AGENT_SNAPSHOT_INCLUDE_IGNORED_EXPLICIT_PATHS: "false",
    AGENT_SNAPSHOT_MANIFEST_SCAN: "true"
  });

  assert.deepEqual(config.settings.snapshot, {
    enabled: false,
    engine: "file-backup",
    maxTextDiffBytes: 1000,
    maxFileBytes: 2000,
    retentionDays: 14,
    includeIgnoredExplicitPaths: false,
    manifestScan: true
  });
}

async function testRuntimeConfigIgnoresRetiredStatusUsageSetting() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-retired-"));
  const alyceDirectory = path.join(workspaceRoot, ".alyce");
  await fs.mkdir(alyceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(alyceDirectory, "settings.json"),
    JSON.stringify({
      statusUsageDisplayEnabled: true,
      scrollSpeed: 4
    }),
    "utf8"
  );

  const config = await loadRuntimeConfig([], {
    ...process.env,
    AGENT_WORKSPACE: workspaceRoot
  });

  assert.equal(config.settings.scrollSpeed, 4);
  assert.equal(
    Object.prototype.hasOwnProperty.call(config.settings, "statusUsageDisplayEnabled"),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(config.settingsState.project, "statusUsageDisplayEnabled"),
    false
  );
}

async function testSessionSettingsSerializationIncludesScrollPerformanceSettings() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-save-"));
  const paths = {
    workspaceRoot,
    alyceDirectory: path.join(workspaceRoot, ".alyce"),
    connectionConfigPath: path.join(workspaceRoot, ".alyce", "config.json"),
    settingsConfigPath: path.join(workspaceRoot, ".alyce", "settings.json"),
    userAlyceDirectory: path.join(workspaceRoot, "user"),
    userConnectionConfigPath: path.join(workspaceRoot, "user", "config.json"),
    userSettingsConfigPath: path.join(workspaceRoot, "user", "settings.json")
  };

  await saveUserSessionSettings(paths, {
    scrollSpeed: 5,
    scrollAccelerationEnabled: true,
    historyPagingEnabled: true,
    maxMessagesWithoutVirtualization: 90,
    diagnosticsPendingTimeoutMs: 50_000,
    diagnosticsFailureThreshold: 4,
    diagnosticsFailureCooldownMs: 70_000,
    snapshot: {
      enabled: true,
      engine: "git-tree",
      maxTextDiffBytes: 100_000,
      maxFileBytes: 300_000,
      retentionDays: 9,
      includeIgnoredExplicitPaths: false,
      manifestScan: true
    },
    permissionRules: [
      {
        permission: "shell",
        pattern: "npm run build",
        action: "allow",
        scope: "persistent",
        reason: "Known local build command."
      }
    ]
  });
  const raw = JSON.parse(await fs.readFile(paths.userSettingsConfigPath, "utf8")) as Record<string, unknown>;

  assert.equal(raw.scrollSpeed, 5);
  assert.equal(raw.scrollAccelerationEnabled, true);
  assert.equal(raw.historyPagingEnabled, true);
  assert.equal(raw.maxMessagesWithoutVirtualization, 90);
  assert.equal(raw.diagnosticsPendingTimeoutMs, 50_000);
  assert.equal(raw.diagnosticsFailureThreshold, 4);
  assert.equal(raw.diagnosticsFailureCooldownMs, 70_000);
  assert.deepEqual(raw.snapshot, {
    enabled: true,
    engine: "git-tree",
    maxTextDiffBytes: 100_000,
    maxFileBytes: 300_000,
    retentionDays: 9,
    includeIgnoredExplicitPaths: false,
    manifestScan: true
  });
  assert.deepEqual(raw.permissionRules, [
    {
      permission: "shell",
      pattern: "npm run build",
      action: "allow",
      scope: "persistent",
      reason: "Known local build command."
    }
  ]);
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
