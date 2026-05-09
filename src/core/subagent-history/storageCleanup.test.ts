import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupSubagentStorageArtifacts } from "./storageCleanup.js";
import { SubagentTaskStorage } from "./storagePaths.js";

async function runTests() {
  await testDryRunAndApplyCleanupForSessionArtifacts();
  await testCleanupMigratedLegacyArtifacts();
  console.log("subagent storage cleanup tests passed");
}

async function testDryRunAndApplyCleanupForSessionArtifacts() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-cleanup-session-"));
  try {
    const storage = new SubagentTaskStorage({
      alyceDirectory: path.join(root, ".alyce"),
      getCurrentSessionId: () => "session-a"
    });

    const subagentsDirectory = storage.getSubagentsDirectory("session-a");
    const outputsDirectory = storage.getTaskOutputsDirectory("session-a");
    await mkdir(subagentsDirectory, { recursive: true });
    await mkdir(outputsDirectory, { recursive: true });

    await writeFile(path.join(outputsDirectory, "orphan.output"), "orphan output", "utf8");
    await writeFile(path.join(subagentsDirectory, "empty.jsonl"), " \n", "utf8");
    await writeFile(path.join(subagentsDirectory, "keep.jsonl"), "{\"type\":\"status\"}\n", "utf8");
    await writeFile(path.join(outputsDirectory, "keep.output"), "keep output", "utf8");

    const dryRun = await cleanupSubagentStorageArtifacts({
      storage,
      apply: false
    });
    assert.equal(dryRun.scannedSessionCount, 1);
    assert.equal(dryRun.orphanOutputFilesFound, 1);
    assert.equal(dryRun.orphanOutputFilesRemoved, 0);
    assert.equal(dryRun.emptyTranscriptsWithoutMetadataFound, 1);
    assert.equal(dryRun.emptyTranscriptsWithoutMetadataRemoved, 0);
    assert.equal(await fileExists(path.join(outputsDirectory, "orphan.output")), true);
    assert.equal(await fileExists(path.join(subagentsDirectory, "empty.jsonl")), true);

    const apply = await cleanupSubagentStorageArtifacts({
      storage,
      apply: true
    });
    assert.equal(apply.orphanOutputFilesFound, 1);
    assert.equal(apply.orphanOutputFilesRemoved, 1);
    assert.equal(apply.emptyTranscriptsWithoutMetadataFound, 1);
    assert.equal(apply.emptyTranscriptsWithoutMetadataRemoved, 1);
    assert.equal(await fileExists(path.join(outputsDirectory, "orphan.output")), false);
    assert.equal(await fileExists(path.join(subagentsDirectory, "empty.jsonl")), false);
    assert.equal(await fileExists(path.join(outputsDirectory, "keep.output")), true);
    assert.equal(await fileExists(path.join(subagentsDirectory, "keep.jsonl")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCleanupMigratedLegacyArtifacts() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-cleanup-legacy-"));
  try {
    const storage = new SubagentTaskStorage({
      alyceDirectory: path.join(root, ".alyce"),
      getCurrentSessionId: () => "session-a"
    });

    await mkdir(path.dirname(storage.getLegacyMigrationMarkerPath()), { recursive: true });
    await writeFile(
      storage.getLegacyMigrationMarkerPath(),
      JSON.stringify(
        {
          version: 1,
          migratedAt: "2026-01-01T00:00:00.000Z",
          unresolvedTaskCount: 0,
          skippedTaskCount: 0,
          failedTaskCount: 0
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(storage.getLegacyTasksArchivePath(), "{\"version\":1,\"tasks\":[]}", "utf8");

    const sessionSubagentsDirectory = storage.getSubagentsDirectory("session-a");
    await mkdir(sessionSubagentsDirectory, { recursive: true });
    await writeFile(
      path.join(sessionSubagentsDirectory, "task-a.meta.json"),
      JSON.stringify({ agentId: "task-a" }, null, 2),
      "utf8"
    );

    const fallbackDirectory = storage.getLegacyFallbackDirectory();
    await mkdir(fallbackDirectory, { recursive: true });
    await writeFile(path.join(fallbackDirectory, "task-a.json"), "{\"taskId\":\"task-a\"}", "utf8");
    await writeFile(path.join(fallbackDirectory, "task-a-1.json"), "{\"taskId\":\"task-a\"}", "utf8");
    await writeFile(path.join(fallbackDirectory, "task-b.json"), "{\"taskId\":\"task-b\"}", "utf8");

    const report = await cleanupSubagentStorageArtifacts({
      storage,
      apply: true
    });
    assert.equal(report.migratedLegacyArchiveFound, true);
    assert.equal(report.migratedLegacyArchiveRemoved, true);
    assert.equal(report.migratedLegacyFallbackFilesFound, 2);
    assert.equal(report.migratedLegacyFallbackFilesRemoved, 2);
    assert.equal(await fileExists(storage.getLegacyTasksArchivePath()), false);
    assert.equal(await fileExists(path.join(fallbackDirectory, "task-a.json")), false);
    assert.equal(await fileExists(path.join(fallbackDirectory, "task-a-1.json")), false);
    assert.equal(await fileExists(path.join(fallbackDirectory, "task-b.json")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
