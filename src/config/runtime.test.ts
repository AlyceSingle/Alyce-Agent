import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getRuntimePaths,
  saveUserSessionSettings,
  type SessionSettings
} from "./runtime.js";

async function runTests() {
  await testSavingEmptyContextWindowOverridesPersistsExplicitClear();
  console.log("runtime config tests passed");
}

async function testSavingEmptyContextWindowOverridesPersistsExplicitClear() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-runtime-config-"));
  try {
    const paths = getRuntimePaths(root);
    await saveUserSessionSettings(paths, {
      modelContextWindowOverrides: {}
    } as Partial<SessionSettings>);

    const raw = await readFile(paths.userSettingsConfigPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    assert.deepEqual(parsed, {
      modelContextWindowOverrides: {}
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void runTests();
