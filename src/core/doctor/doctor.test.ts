import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildConnectionConfigState,
  buildSessionSettingsState,
  getRuntimePaths,
  type ConnectionConfigState,
  type SessionSettingsState
} from "../../config/runtime.js";
import {
  formatDoctorReport,
  runDoctorDiagnostics,
  type DoctorCheck,
  type DoctorCommandResult,
  type DoctorRuntimeInput
} from "./doctor.js";

async function runTests() {
  await testHealthyBaselineHasNoFailures();
  await testMissingApiKeyFails();
  await testMissingEndpointAndModelWarns();
  await testLocalProviderWithoutBaseUrlFailsProviderCheck();
  await testInvalidMcpConfigFails();
  await testMissingMcpConfigIsReportedAsUnconfigured();
  await testRipgrepUnavailableFails();
  await testSnapshotDiagnosticsWarnsWhenGitTreeUnavailable();
  await testSnapshotDiagnosticsFailsWhenGitTreeAndOverlayUnavailable();
  await testProviderPluginDiagnosticsWarn();
  await testOldNodeVersionFails();
  testFormatDoctorReportIncludesFixes();
  console.log("doctor tests passed");
}

async function testSnapshotDiagnosticsWarnsWhenGitTreeUnavailable() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" }),
    snapshotDiagnostics: {
      ...createSnapshotDiagnostics(workspaceRoot),
      gitAvailable: false
    }
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "snapshot.store");
  assert.equal(check.status, "warn");
  assert.match(check.summary, /Git-tree snapshots are unavailable/);
}

async function testSnapshotDiagnosticsFailsWhenGitTreeAndOverlayUnavailable() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" }),
    snapshotDiagnostics: {
      ...createSnapshotDiagnostics(workspaceRoot),
      gitAvailable: false,
      includeIgnoredExplicitPaths: false
    }
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "snapshot.store");
  assert.equal(check.status, "fail");
  assert.match(check.summary, /file-history overlays are disabled/);
}

async function testLocalProviderWithoutBaseUrlFailsProviderCheck() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: buildConnectionConfigState(getRuntimePaths(workspaceRoot), {
      user: {
        model: "local/qwen",
        providers: {
          local: {
            kind: "local",
            defaultModel: "qwen",
            models: {
              qwen: {}
            }
          }
        }
      }
    })
  });

  const report = await runDoctorDiagnostics(input, {
    env: {},
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "connection.apiKey");
  assert.equal(check.status, "fail");
  assert.match(check.summary, /requires a baseURL/);
}

async function testHealthyBaselineHasNoFailures() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, {
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4.1-mini"
    })
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  assert.equal(findCheck(report.checks, "node.version").status, "ok");
  assert.equal(findCheck(report.checks, "connection.apiKey").status, "ok");
  assert.equal(findCheck(report.checks, "project.integrity").status, "ok");
  assert.equal(report.summary.fail, 0);
}

async function testMissingApiKeyFails() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, {})
  });

  const report = await runDoctorDiagnostics(input, {
    env: {},
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "connection.apiKey");
  assert.equal(check.status, "fail");
  assert.ok(check.suggestion?.includes("/connect"));
}

async function testMissingEndpointAndModelWarns() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" })
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "connection.model");
  assert.equal(check.status, "warn");
  assert.ok(check.details?.some((detail) => detail.includes("OPENAI_BASE_URL")));
  assert.ok(check.details?.some((detail) => detail.includes("OPENAI_MODEL")));
  assert.ok(check.suggestion?.includes("/connect"));
}

async function testInvalidMcpConfigFails() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  await fs.mkdir(path.join(workspaceRoot, ".alyce"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, ".alyce", "mcp.json"), "{", "utf8");
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" })
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "mcp.config");
  assert.equal(check.status, "fail");
  assert.ok(check.details?.some((detail) => detail.includes("mcp.json")));
}

async function testMissingMcpConfigIsReportedAsUnconfigured() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" })
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "mcp.config");
  assert.equal(check.status, "ok");
  assert.match(check.summary, /No MCP config files found yet/);
}

async function testRipgrepUnavailableFails() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" })
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: async (command) => {
      if (command === "rg") {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          error: "ENOENT"
        };
      }

      return fakeCommandRunner(command);
    }
  });

  const check = findCheck(report.checks, "tool.rg");
  assert.equal(check.status, "fail");
  assert.ok(check.suggestion?.includes("ripgrep"));
}

async function testOldNodeVersionFails() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" })
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "18.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "node.version");
  assert.equal(check.status, "fail");
  assert.ok(check.summary.includes("below"));
}

async function testProviderPluginDiagnosticsWarn() {
  const workspaceRoot = await createWorkspace({ includeDist: true });
  const input = createDoctorInput(workspaceRoot, {
    connection: createConnectionState(workspaceRoot, { apiKey: "test-key" }),
    providerPluginDiagnostics: [{
      severity: "warning",
      source: "user",
      pluginPath: path.join(workspaceRoot, "plugin"),
      message: "Invalid manifest."
    }]
  });

  const report = await runDoctorDiagnostics(input, {
    env: { OPENAI_API_KEY: "test-key" },
    nodeVersion: "20.10.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    runCommand: fakeCommandRunner
  });

  const check = findCheck(report.checks, "provider.plugins");
  assert.equal(check.status, "warn");
  assert.match(check.summary, /connector plugin issue/);
}

function testFormatDoctorReportIncludesFixes() {
  const content = formatDoctorReport({
    generatedAt: "2026-05-13T00:00:00.000Z",
    workspaceRoot: "D:\\Code\\AlyceAgent",
    summary: {
      ok: 0,
      warn: 0,
      fail: 1,
      skipped: 0
    },
    checks: [
      {
        id: "example",
        title: "Example",
        status: "fail",
        summary: "Broken.",
        suggestion: "Fix it."
      }
    ]
  });

  assert.ok(content.includes("Summary: 0 ok, 0 warn, 1 fail, 0 skipped"));
  assert.ok(content.includes("[fail] Example: Broken."));
  assert.ok(content.includes("Fix: Fix it."));
}

async function createWorkspace(options: { includeDist: boolean }): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-doctor-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ name: "alyce-test" }),
    "utf8"
  );
  await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");
  if (options.includeDist) {
    await fs.mkdir(path.join(workspaceRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "dist", "index.js"), "export {};\n", "utf8");
  }
  await fs.mkdir(createRuntimePathsForTest(workspaceRoot).workspaceRuntimeDirectory, { recursive: true });
  return workspaceRoot;
}

function createDoctorInput(
  workspaceRoot: string,
  overrides: {
    connection?: ConnectionConfigState;
    settings?: SessionSettingsState;
    providerPluginDiagnostics?: DoctorRuntimeInput["providerPluginDiagnostics"];
    snapshotDiagnostics?: DoctorRuntimeInput["snapshotDiagnostics"];
  } = {}
): DoctorRuntimeInput {
  const paths = createRuntimePathsForTest(workspaceRoot);
  const settingsState = overrides.settings ?? buildSessionSettingsState(paths, {});
  const connectionState = overrides.connection ?? createConnectionState(workspaceRoot, {});

  return {
    workspaceRoot,
    paths,
    connectionState,
    settingsState,
    settings: settingsState.effective,
    currentModel: connectionState.effective.model,
    hasConnectionConfig: connectionState.effective.apiKey.trim().length > 0,
    allowedRoots: [workspaceRoot],
    requestPatchCount: 0,
    providerPluginDiagnostics: overrides.providerPluginDiagnostics,
    snapshotDiagnostics: overrides.snapshotDiagnostics ?? createSnapshotDiagnostics(workspaceRoot)
  };
}

function createSnapshotDiagnostics(workspaceRoot: string): DoctorRuntimeInput["snapshotDiagnostics"] {
  return {
    enabled: true,
    configuredEngine: "hybrid",
    activeEngine: "hybrid",
    gitTreeEnabled: true,
    gitAvailable: true,
    workspaceRoot,
    snapshotRoot: path.join(workspaceRoot, ".alyce", "snapshots", "git"),
    gitDirectory: path.join(workspaceRoot, ".alyce", "snapshots", "git", "workspace"),
    retentionDays: 7,
    maxTextDiffBytes: 524_288,
    maxFileBytes: 2_097_152,
    includeIgnoredExplicitPaths: true,
    manifestScan: true,
    records: 0
  };
}

function createConnectionState(
  workspaceRoot: string,
  env: Partial<{ apiKey: string; baseURL: string; model: string }>
): ConnectionConfigState {
  return buildConnectionConfigState(createRuntimePathsForTest(workspaceRoot), {
    env
  });
}

function createRuntimePathsForTest(workspaceRoot: string) {
  const userHomeDirectory = path.join(workspaceRoot, "user-home");
  return {
    ...getRuntimePaths(workspaceRoot),
    userAlyceDirectory: path.join(userHomeDirectory, ".alyce"),
    userConnectionConfigPath: path.join(userHomeDirectory, ".alyce", "config.json"),
    userSettingsConfigPath: path.join(userHomeDirectory, ".alyce", "settings.json"),
    userSkillsDirectory: path.join(userHomeDirectory, ".alyce", "skills"),
    userPluginsDirectory: path.join(userHomeDirectory, ".alyce", "plugins"),
    workspaceRuntimeDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace"),
    memoryDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "memory"),
    sessionsDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "sessions"),
    backgroundProcessesDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "background-processes"),
    mcpOutputDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "mcp-output"),
    snapshotsDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "snapshots"),
    gitSnapshotsDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "snapshots", "git"),
    fileHistoryDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "file-history"),
    tasksDirectory: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "tasks"),
    usageLogPath: path.join(userHomeDirectory, ".alyce", "workspace-state", "workspace", "usage.jsonl"),
    projectTrustStorePath: path.join(userHomeDirectory, ".alyce", "trusted-projects.json")
  };
}

async function fakeCommandRunner(command: string): Promise<DoctorCommandResult> {
  return {
    ok: true,
    stdout: command === "rg" ? "ripgrep 14.1.0\n" : "git version 2.45.0\n",
    stderr: "",
    exitCode: 0,
    timedOut: false
  };
}

function findCheck(checks: DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((candidate) => candidate.id === id);
  assert.ok(check, `Expected check ${id}`);
  return check;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
