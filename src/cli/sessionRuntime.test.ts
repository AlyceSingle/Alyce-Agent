import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildSessionSettingsState, type SessionSettings } from "../config/runtime.js";
import { AuthStore, getAuthStorePath } from "../core/auth/authStore.js";
import { isFileBackupSnapshotEnabled, createSessionRuntime } from "./sessionRuntime.js";
import { resolveConnectProvider } from "./connectCommand.js";
import { resolveSubagentAllowedRoots } from "./subagentAllowedRoots.js";
import { normalizePersistedSubagentProgress } from "./subagentProgress.js";

interface TestSettings {
  additionalDirectories: string[];
}

async function runTests() {
  testSubagentAllowedRootsInheritDefaultWhenUnset();
  testSubagentAllowedRootsRestrictWhenSet();
  testSubagentAllowedRootsDeduplicateConfiguredValues();
  testFileBackupSnapshotEnabledHonorsSnapshotEngineAndOverlayFlag();
  testPersistedSubagentProgressIsSanitized();
  testPersistedSubagentProgressIsLimited();
  await testProviderConnectionWritesAuthStoreNotProjectConfig();
  await testRuntimeAppliesGitHubCopilotOAuthFromAuthStore();
  await testRuntimeRefreshesCurrentProviderModelsInMemory();
  console.log("sessionRuntime tests passed");
}

function createSettings(patch: Partial<TestSettings> = {}): TestSettings {
  return {
    additionalDirectories: [],
    ...patch
  };
}

function createFullSettings(patch: Partial<SessionSettings> = {}): SessionSettings {
  return buildSessionSettingsState({
    workspaceRoot: path.resolve("workspace"),
    settingsConfigPath: path.resolve("workspace", ".alyce", "settings.json"),
    userSettingsConfigPath: path.resolve("user", "settings.json")
  }, {
    user: patch
  }).effective;
}

function testSubagentAllowedRootsInheritDefaultWhenUnset() {
  const workspaceRoot = path.resolve("workspace");
  const projectExtra = path.resolve("project-extra");
  const sessionExtra = path.resolve("session-extra");

  const roots = resolveSubagentAllowedRoots(
    workspaceRoot,
    {
      policy: {}
    },
    createSettings({
      additionalDirectories: [projectExtra]
    }),
    [sessionExtra]
  );

  assert.deepEqual(roots, [
    workspaceRoot,
    projectExtra,
    sessionExtra
  ]);
}

function testSubagentAllowedRootsRestrictWhenSet() {
  const workspaceRoot = path.resolve("workspace");
  const projectExtra = path.resolve("project-extra");
  const sessionExtra = path.resolve("session-extra");
  const subagentRoot = path.resolve(workspaceRoot, "src");

  const roots = resolveSubagentAllowedRoots(
    workspaceRoot,
    {
      policy: {
        allowedRoots: ["src"]
      }
    },
    createSettings({
      additionalDirectories: [projectExtra]
    }),
    [sessionExtra]
  );

  assert.deepEqual(roots, [subagentRoot]);
}

function testSubagentAllowedRootsDeduplicateConfiguredValues() {
  const workspaceRoot = path.resolve("workspace");
  const roots = resolveSubagentAllowedRoots(
    workspaceRoot,
    {
      policy: {
        allowedRoots: ["src", "./src", " src "]
      }
    },
    createSettings(),
    []
  );

  assert.deepEqual(roots, [path.resolve(workspaceRoot, "src")]);
}

function testFileBackupSnapshotEnabledHonorsSnapshotEngineAndOverlayFlag() {
  const base = createFullSettings();

  assert.equal(isFileBackupSnapshotEnabled(base), true);
  assert.equal(isFileBackupSnapshotEnabled({
    ...base,
    snapshot: {
      ...base.snapshot,
      includeIgnoredExplicitPaths: false
    }
  }), false);
  assert.equal(isFileBackupSnapshotEnabled({
    ...base,
    snapshot: {
      ...base.snapshot,
      engine: "file-backup",
      includeIgnoredExplicitPaths: false
    }
  }), true);
  assert.equal(isFileBackupSnapshotEnabled({
    ...base,
    snapshot: {
      ...base.snapshot,
      engine: "git-tree"
    }
  }), false);
  assert.equal(isFileBackupSnapshotEnabled({
    ...base,
    snapshot: {
      ...base.snapshot,
      enabled: false
    }
  }), false);
}

function testPersistedSubagentProgressIsSanitized() {
  const progress = normalizePersistedSubagentProgress([
    {
      timestamp: "2026-05-06T00:00:01.000Z",
      type: "status",
      message: "x".repeat(4_100)
    },
    {
      timestamp: "2026-05-06T00:00:02.000Z",
      type: "unknown",
      message: "drop me"
    },
    "drop me too",
    {
      timestamp: "2026-05-06T00:00:03.000Z",
      type: "tool_result",
      toolName: "Read",
      rawArguments: "y".repeat(8_100),
      result: { invalid: true }
    }
  ]);

  assert.equal(progress.length, 2);
  assert.equal(progress[0]?.type, "status");
  assert.match(progress[0]?.message ?? "", /\[truncated 100 chars\]/);
  assert.equal(progress[1]?.type, "tool_result");
  assert.equal(progress[1]?.toolName, "Read");
  assert.match(progress[1]?.rawArguments ?? "", /\[truncated 100 chars\]/);
  assert.equal(progress[1]?.result, undefined);
}

function testPersistedSubagentProgressIsLimited() {
  const progress = normalizePersistedSubagentProgress(
    Array.from({ length: 105 }, (_, index) => ({
      timestamp: `2026-05-06T00:00:00.${String(index).padStart(3, "0")}Z`,
      type: "status",
      message: `event ${index}`
    }))
  );

  assert.equal(progress.length, 100);
  assert.equal(progress[0]?.message, "event 5");
  assert.equal(progress[99]?.message, "event 104");
}

async function testProviderConnectionWritesAuthStoreNotProjectConfig() {
  const originalHomedir = os.homedir;
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-runtime-home-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-runtime-workspace-"));
  os.homedir = () => homeDirectory;
  let runtime: Awaited<ReturnType<typeof createSessionRuntime>> | null = null;

  try {
    runtime = await createSessionRuntime([], {
      AGENT_WORKSPACE: workspaceRoot
    });
    const connect = resolveConnectProvider("openrouter", ["router-key"], {
      connectionState: runtime.getConnectionConfigState()
    });
    assert.equal(connect.ok, true);
    if (!connect.ok) {
      return;
    }

    await runtime.applyProviderConnection(connect.plan);

    const authJson = JSON.parse(await fs.readFile(runtime.getAuthStorePath(), "utf8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    assert.equal(authJson.providers?.openrouter?.apiKey, "router-key");
    assert.equal(runtime.getConnectionConfigState().providerProfiles.openrouter?.apiKey, "router-key");

    const userConfig = JSON.parse(
      await fs.readFile(path.join(homeDirectory, ".alyce", "config.json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(userConfig.model, "openrouter/openai/gpt-5.2");
    assert.equal(Object.prototype.hasOwnProperty.call(userConfig, "apiKey"), false);

    await assert.rejects(
      () => fs.readFile(path.join(workspaceRoot, ".alyce", "config.json"), "utf8"),
      (error: unknown) =>
        Boolean(error && typeof error === "object" && "code" in error &&
          (error as { code?: string }).code === "ENOENT")
    );

    assert.equal(await runtime.removeProviderAuth("openrouter"), true);
    assert.equal(runtime.getConnectionConfigState().providerProfiles.openrouter?.apiKey, undefined);
  } finally {
    await runtime?.flushSessionHistory();
    os.homedir = originalHomedir;
  }
}

async function testRuntimeAppliesGitHubCopilotOAuthFromAuthStore() {
  const originalHomedir = os.homedir;
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-runtime-home-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-runtime-workspace-"));
  os.homedir = () => homeDirectory;
  let runtime: Awaited<ReturnType<typeof createSessionRuntime>> | null = null;

  try {
    const authStore = await AuthStore.load(getAuthStorePath(path.join(homeDirectory, ".alyce")));
    await authStore.set("github-copilot", {
      type: "oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      extra: { enterpriseUrl: "ghe.example.com" }
    });

    runtime = await createSessionRuntime([], {
      AGENT_WORKSPACE: workspaceRoot,
      OPENAI_MODEL: "github-copilot/gpt-5.2"
    });

    const profile = runtime.getConnectionConfigState().providerProfiles["github-copilot"];
    assert.equal(profile?.apiKey, "refresh-token");
    assert.equal(profile?.baseURL, "https://copilot-api.ghe.example.com");
    assert.equal(profile?.headers?.Authorization, "Bearer refresh-token");
    assert.equal(runtime.hasConnectionConfig(), true);
  } finally {
    await runtime?.flushSessionHistory();
    os.homedir = originalHomedir;
  }
}

async function testRuntimeRefreshesCurrentProviderModelsInMemory() {
  const originalHomedir = os.homedir;
  const originalFetch = globalThis.fetch;
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-runtime-home-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-runtime-workspace-"));
  os.homedir = () => homeDirectory;
  let runtime: Awaited<ReturnType<typeof createSessionRuntime>> | null = null;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      data: [
        { id: "gpt-live", name: "GPT Live" }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    runtime = await createSessionRuntime([], {
      AGENT_WORKSPACE: workspaceRoot,
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-5.2"
    });

    const result = await runtime.refreshCurrentProviderModels();

    assert.equal(result.source, "live");
    assert.deepEqual(calls, ["https://api.openai.com/v1/models"]);
    assert.equal(runtime.getConnectionConfigState().providerProfiles.openai?.models?.["gpt-live"]?.label, "GPT Live");
    assert.equal(runtime.getConnectionConfigState().providerProfiles.anthropic?.models?.["claude-sonnet-4.6"]?.label, "Claude Sonnet 4.6");
  } finally {
    await runtime?.flushSessionHistory();
    globalThis.fetch = originalFetch;
    os.homedir = originalHomedir;
  }
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
