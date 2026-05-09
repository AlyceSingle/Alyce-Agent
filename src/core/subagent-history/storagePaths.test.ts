import assert from "node:assert/strict";
import path from "node:path";
import { SubagentTaskStorage } from "./storagePaths.js";

function runTests() {
  testLegacyTasksPath();
  testSessionBoundTaskPaths();
  testExplicitSessionOverride();
  testLegacyMigrationPaths();
  testSessionsDirectoryPath();
  console.log("subagent task storage path tests passed");
}

function testLegacyTasksPath() {
  const storage = new SubagentTaskStorage({
    alyceDirectory: path.join("D:", "repo", ".alyce"),
    getCurrentSessionId: () => "session-a"
  });

  assert.equal(
    storage.getLegacyTasksFilePath(),
    path.join("D:", "repo", ".alyce", "tasks", "tasks.json")
  );
}

function testSessionBoundTaskPaths() {
  const storage = new SubagentTaskStorage({
    alyceDirectory: path.join("D:", "repo", ".alyce"),
    getCurrentSessionId: () => "session-a"
  });
  const paths = storage.getTaskStoragePaths("agent-1");

  assert.equal(paths.sessionId, "session-a");
  assert.equal(paths.parentSessionId, "session-a");
  assert.equal(
    paths.transcriptPath,
    path.join("D:", "repo", ".alyce", "sessions", "session-a", "subagents", "agent-1.jsonl")
  );
  assert.equal(
    paths.metadataPath,
    path.join("D:", "repo", ".alyce", "sessions", "session-a", "subagents", "agent-1.meta.json")
  );
  assert.equal(
    paths.outputPath,
    path.join("D:", "repo", ".alyce", "sessions", "session-a", "tasks", "agent-1.output")
  );
}

function testExplicitSessionOverride() {
  const storage = new SubagentTaskStorage({
    alyceDirectory: path.join("D:", "repo", ".alyce"),
    getCurrentSessionId: () => "session-a"
  });
  const identity = storage.getStorageIdentity("agent-2", "session-b");

  assert.equal(identity.parentSessionId, "session-b");
  assert.equal(
    identity.transcriptPath,
    path.join("D:", "repo", ".alyce", "sessions", "session-b", "subagents", "agent-2.jsonl")
  );
}

function testLegacyMigrationPaths() {
  const storage = new SubagentTaskStorage({
    alyceDirectory: path.join("D:", "repo", ".alyce"),
    getCurrentSessionId: () => "session-a"
  });

  assert.equal(
    storage.getLegacyTasksArchivePath(),
    path.join("D:", "repo", ".alyce", "tasks", "tasks.legacy.json")
  );
  assert.equal(
    storage.getLegacyMigrationMarkerPath(),
    path.join("D:", "repo", ".alyce", "tasks", "tasks.migration.v1.json")
  );
  assert.equal(
    storage.getLegacyFallbackDirectory(),
    path.join("D:", "repo", ".alyce", "tasks", "legacy")
  );
}

function testSessionsDirectoryPath() {
  const storage = new SubagentTaskStorage({
    alyceDirectory: path.join("D:", "repo", ".alyce"),
    getCurrentSessionId: () => "session-a"
  });

  assert.equal(
    storage.getSessionsDirectory(),
    path.join("D:", "repo", ".alyce", "sessions")
  );
}

runTests();
