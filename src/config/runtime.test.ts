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
    AGENT_MAX_MESSAGES_WITHOUT_VIRTUALIZATION: "75"
  });

  assert.equal(config.settings.scrollSpeed, 6);
  assert.equal(config.settings.scrollAccelerationEnabled, true);
  assert.equal(config.settings.historyPagingEnabled, true);
  assert.equal(config.settings.maxMessagesWithoutVirtualization, 75);
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
    maxMessagesWithoutVirtualization: 90
  });
  const raw = JSON.parse(await fs.readFile(paths.userSettingsConfigPath, "utf8")) as Record<string, unknown>;

  assert.equal(raw.scrollSpeed, 5);
  assert.equal(raw.scrollAccelerationEnabled, true);
  assert.equal(raw.historyPagingEnabled, true);
  assert.equal(raw.maxMessagesWithoutVirtualization, 90);
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
