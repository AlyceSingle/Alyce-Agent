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
  testSessionSettingsNormalizesApprovalModes();
  testSessionSettingsClampsScrollSpeed();
  await testRuntimeConfigBootstrapsRuntimeDirectories();
  await testRuntimeConfigLoadsUserConnectorPlugin();
  await testRuntimeConfigReadsScrollPerformanceEnv();
  await testRuntimeConfigReadsLegacyApprovalModes();
  await testRuntimeConfigMapsYoloToFullAccess();
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

async function loadRuntimeConfigForTest(
  argv: string[],
  env: NodeJS.ProcessEnv
) {
  return withTemporaryHome(() => loadRuntimeConfig(argv, env));
}

async function withTemporaryHome<T>(callback: (homeDirectory: string) => Promise<T>): Promise<T> {
  const originalHomedir = os.homedir;
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-home-"));
  os.homedir = () => homeDirectory;
  try {
    return await callback(homeDirectory);
  } finally {
    os.homedir = originalHomedir;
  }
}

function testSessionSettingsDefaultsIncludeScrollPerformanceSettings() {
  const state = buildSessionSettingsState(createPaths("C:\\workspace"), {});

  assert.equal(state.effective.scrollSpeed, 2);
  assert.equal(state.effective.approvalMode, "default");
  assert.equal(state.effective.scrollAccelerationEnabled, false);
  assert.equal(state.effective.historyPagingEnabled, false);
  assert.equal(state.effective.maxMessagesWithoutVirtualization, 200);
  assert.equal(state.effective.thinkingMessagesExpandedByDefault, false);
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

function testSessionSettingsNormalizesApprovalModes() {
  const readOnly = buildSessionSettingsState(createPaths("C:\\workspace"), {
    user: { approvalMode: "read-only" }
  });
  const autoReview = buildSessionSettingsState(createPaths("C:\\workspace"), {
    user: { approvalMode: "auto-review" }
  });
  const fullAccess = buildSessionSettingsState(createPaths("C:\\workspace"), {
    user: { approvalMode: "full-access" }
  });

  assert.equal(readOnly.effective.approvalMode, "read-only");
  assert.equal(autoReview.effective.approvalMode, "auto-review");
  assert.equal(fullAccess.effective.approvalMode, "full-access");
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

async function testRuntimeConfigBootstrapsRuntimeDirectories() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-bootstrap-"));
  const config = await loadRuntimeConfigForTest([], {
    ...process.env,
    AGENT_WORKSPACE: workspaceRoot
  });

  const expectedDirectories = [
    config.paths.alyceDirectory,
    path.join(config.paths.alyceDirectory, "skills"),
    config.paths.projectPluginsDirectory,
    path.join(config.paths.alyceDirectory, "agents"),
    path.join(config.paths.alyceDirectory, "memory"),
    path.join(config.paths.alyceDirectory, "sessions"),
    path.join(config.paths.alyceDirectory, "background-processes"),
    path.join(config.paths.alyceDirectory, "mcp-output"),
    path.join(config.paths.alyceDirectory, "snapshots", "git"),
    path.join(config.paths.alyceDirectory, "file-history"),
    path.join(config.paths.alyceDirectory, "tasks"),
    config.paths.userAlyceDirectory,
    path.join(config.paths.userAlyceDirectory, "skills"),
    config.paths.userPluginsDirectory
  ];

  for (const directory of expectedDirectories) {
    assert.equal((await fs.stat(directory)).isDirectory(), true, directory);
  }

  assert.equal(config.bootstrap.createdPaths.length >= expectedDirectories.length, true);
  assert.equal(config.bootstrap.failedPaths.length, 0);
  assert.equal(config.bootstrap.firstRun, true);

  await assert.rejects(fs.stat(config.paths.connectionConfigPath), { code: "ENOENT" });
  await assert.rejects(fs.stat(config.paths.settingsConfigPath), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(config.paths.alyceDirectory, "mcp.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(config.paths.userAlyceDirectory, "auth.json")), { code: "ENOENT" });
}

async function testRuntimeConfigLoadsUserConnectorPlugin() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-plugin-"));
  const config = await withTemporaryHome(async (homeDirectory) => {
    const pluginDirectory = path.join(homeDirectory, ".alyce", "plugins", "acme");
    await fs.mkdir(pluginDirectory, { recursive: true });
    await fs.writeFile(
      path.join(pluginDirectory, ".alyce-plugin.json"),
      JSON.stringify({
        version: 1,
        id: "acme",
        label: "Acme AI",
        provider: {
          baseURL: "https://api.acme.example/v1",
          defaultModel: "acme-large",
          models: {
            "acme-large": {}
          }
        }
      }),
      "utf8"
    );

    return loadRuntimeConfig([], {
      ...process.env,
      AGENT_WORKSPACE: workspaceRoot
    });
  });

  assert.ok(config.providerConnectors.some((connector) => connector.id === "acme"));
  assert.equal(config.connectionState.providerProfiles.acme?.baseURL, "https://api.acme.example/v1");
  assert.equal(config.providerPluginDiagnostics.length, 0);
}

async function testRuntimeConfigReadsScrollPerformanceEnv() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-"));
  const config = await loadRuntimeConfigForTest([], {
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

async function testRuntimeConfigReadsLegacyApprovalModes() {
  const manualWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-manual-"));
  await fs.mkdir(path.join(manualWorkspace, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(manualWorkspace, ".alyce", "settings.json"),
    JSON.stringify({ approvalMode: "manual" }),
    "utf8"
  );
  const manual = await loadRuntimeConfigForTest([], {
    ...process.env,
    AGENT_WORKSPACE: manualWorkspace
  });

  const autoWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-auto-"));
  await fs.mkdir(path.join(autoWorkspace, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(autoWorkspace, ".alyce", "settings.json"),
    JSON.stringify({ approvalMode: "auto" }),
    "utf8"
  );
  const auto = await loadRuntimeConfigForTest([], {
    ...process.env,
    AGENT_WORKSPACE: autoWorkspace
  });

  assert.equal(manual.settings.approvalMode, "default");
  assert.equal(auto.settings.approvalMode, "full-access");
}

async function testRuntimeConfigMapsYoloToFullAccess() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-yolo-"));
  const config = await loadRuntimeConfigForTest(["--yolo"], {
    ...process.env,
    AGENT_WORKSPACE: workspaceRoot
  });

  assert.equal(config.settings.approvalMode, "full-access");
}

async function testRuntimeConfigReadsSnapshotSettingsFromEnv() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-snapshot-"));
  const config = await loadRuntimeConfigForTest([], {
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

  const config = await loadRuntimeConfigForTest([], {
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
    projectPluginsDirectory: path.join(workspaceRoot, ".alyce", "plugins"),
    userAlyceDirectory: path.join(workspaceRoot, "user"),
    userConnectionConfigPath: path.join(workspaceRoot, "user", "config.json"),
    userSettingsConfigPath: path.join(workspaceRoot, "user", "settings.json"),
    userPluginsDirectory: path.join(workspaceRoot, "user", "plugins")
  };

  await saveUserSessionSettings(paths, {
    scrollSpeed: 5,
    approvalMode: "auto-review",
    scrollAccelerationEnabled: true,
    historyPagingEnabled: true,
    maxMessagesWithoutVirtualization: 90,
    thinkingMessagesExpandedByDefault: true,
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
  assert.equal(raw.approvalMode, "auto-review");
  assert.equal(raw.scrollAccelerationEnabled, true);
  assert.equal(raw.historyPagingEnabled, true);
  assert.equal(raw.maxMessagesWithoutVirtualization, 90);
  assert.equal(raw.thinkingMessagesExpandedByDefault, true);
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
