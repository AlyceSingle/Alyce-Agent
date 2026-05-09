import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentHistoryStore } from "./historyStore.js";
import { migrateLegacySubagentTasks } from "./legacyMigration.js";
import { SubagentTaskStorage } from "./storagePaths.js";
import type { LegacyPersistedSubagentTaskFile, SubagentTranscriptEntry } from "./types.js";

async function runTests() {
  await testMigratesKnownSessionTaskAndArchivesLegacyFile();
  await testWritesUnresolvedTaskWhenSessionCannotBeInferred();
  await testMarkerPreventsRepeatedMigration();
  console.log("legacy migration tests passed");
}

async function testMigratesKnownSessionTaskAndArchivesLegacyFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-legacy-migration-success-"));
  try {
    const alyceDirectory = path.join(root, ".alyce");
    const storage = new SubagentTaskStorage({
      alyceDirectory,
      getCurrentSessionId: () => "current-session"
    });
    const historyStore = new SubagentHistoryStore();
    const legacyPayload: LegacyPersistedSubagentTaskFile = {
      version: 1,
      tasks: [
        {
          taskId: "task-1",
          agentType: "explore",
          description: "inspect files",
          model: "gpt-test",
          maxSteps: 5,
          parentSessionId: "session-a",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          status: "running",
          messages: [
            { role: "system", content: "system prompt" },
            { role: "assistant", content: "working..." }
          ],
          output: "final output"
        }
      ]
    };

    await writeLegacyTasksFile(storage.getLegacyTasksFilePath(), legacyPayload);
    await migrateLegacySubagentTasks({ storage, historyStore });

    const metadataPath = path.join(alyceDirectory, "sessions", "session-a", "subagents", "task-1.meta.json");
    const transcriptPath = path.join(alyceDirectory, "sessions", "session-a", "subagents", "task-1.jsonl");
    const outputPath = path.join(alyceDirectory, "sessions", "session-a", "tasks", "task-1.output");

    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      parentSessionId: string;
      agentId: string;
    };
    assert.equal(metadata.agentId, "task-1");
    assert.equal(metadata.parentSessionId, "session-a");

    const transcriptLines = (await readFile(transcriptPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(transcriptLines.length, 4);
    const parsedEntries = transcriptLines.map((line) => JSON.parse(line) as SubagentTranscriptEntry);
    const statusEntry = parsedEntries[parsedEntries.length - 1];
    assert.equal(statusEntry?.type, "status");
    assert.equal(statusEntry?.status, "failed");

    const output = await readFile(outputPath, "utf8");
    assert.equal(output, "final output");

    assert.equal(await fileExists(storage.getLegacyTasksFilePath()), false);
    assert.equal(await fileExists(storage.getLegacyTasksArchivePath()), true);
    assert.equal(await fileExists(storage.getLegacyMigrationMarkerPath()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testWritesUnresolvedTaskWhenSessionCannotBeInferred() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-legacy-migration-unresolved-"));
  try {
    const alyceDirectory = path.join(root, ".alyce");
    const storage = new SubagentTaskStorage({
      alyceDirectory,
      getCurrentSessionId: () => "current-session"
    });
    const historyStore = new SubagentHistoryStore();
    const legacyPayload: LegacyPersistedSubagentTaskFile = {
      version: 1,
      tasks: [
        {
          taskId: "task-unknown",
          agentType: "explore",
          description: "cannot infer session",
          model: "gpt-test",
          maxSteps: 3,
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          status: "completed",
          messages: []
        }
      ]
    };

    await writeLegacyTasksFile(storage.getLegacyTasksFilePath(), legacyPayload);
    await migrateLegacySubagentTasks({ storage, historyStore });

    const unresolvedPath = path.join(storage.getLegacyFallbackDirectory(), "task-unknown.json");
    assert.equal(await fileExists(unresolvedPath), true);
    assert.equal(await fileExists(storage.getLegacyTasksArchivePath()), true);
    assert.equal(await fileExists(storage.getLegacyMigrationMarkerPath()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testMarkerPreventsRepeatedMigration() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-legacy-migration-marker-"));
  try {
    const alyceDirectory = path.join(root, ".alyce");
    const storage = new SubagentTaskStorage({
      alyceDirectory,
      getCurrentSessionId: () => "current-session"
    });
    const historyStore = new SubagentHistoryStore();
    const firstPayload: LegacyPersistedSubagentTaskFile = {
      version: 1,
      tasks: [
        {
          taskId: "task-first",
          agentType: "explore",
          description: "first",
          model: "gpt-test",
          maxSteps: 2,
          parentSessionId: "session-a",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:01:00.000Z",
          status: "completed",
          messages: []
        }
      ]
    };
    await writeLegacyTasksFile(storage.getLegacyTasksFilePath(), firstPayload);
    await migrateLegacySubagentTasks({ storage, historyStore });

    const secondPayload: LegacyPersistedSubagentTaskFile = {
      version: 1,
      tasks: [
        {
          taskId: "task-second",
          agentType: "explore",
          description: "second",
          model: "gpt-test",
          maxSteps: 2,
          parentSessionId: "session-b",
          createdAt: "2026-05-02T00:00:00.000Z",
          updatedAt: "2026-05-02T00:01:00.000Z",
          status: "completed",
          messages: []
        }
      ]
    };
    await writeLegacyTasksFile(storage.getLegacyTasksFilePath(), secondPayload);
    await migrateLegacySubagentTasks({ storage, historyStore });

    const secondTaskMetadataPath = path.join(
      alyceDirectory,
      "sessions",
      "session-b",
      "subagents",
      "task-second.meta.json"
    );
    assert.equal(await fileExists(secondTaskMetadataPath), false);
    assert.equal(await fileExists(storage.getLegacyTasksFilePath()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeLegacyTasksFile(
  filePath: string,
  payload: LegacyPersistedSubagentTaskFile
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

void runTests();
