import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupSnapshotStorage } from "./snapshotCleanup.js";

async function runTests() {
  await testCleanupScansStaleSnapshotDirectoriesWithoutApply();
  await testCleanupRemovesStaleSnapshotDirectoriesWithApply();
  await testCleanupSkipsExcludedSnapshotDirectories();
  console.log("snapshotCleanup tests passed");
}

async function testCleanupScansStaleSnapshotDirectoriesWithoutApply() {
  await withTempWorkspace(async (alyceDirectory) => {
    const stale = path.join(alyceDirectory, "snapshots", "git", "stale");
    await fs.mkdir(stale, { recursive: true });
    await makeOld(stale);

    const report = await cleanupSnapshotStorage({
      alyceDirectory,
      retentionDays: 7,
      apply: false,
      now: new Date("2026-05-15T00:00:00.000Z")
    });

    assert.equal(report.scanned, 1);
    assert.deepEqual(report.stale.map((target) => target.path), [stale]);
    assert.deepEqual(report.removed, []);
    assert.equal((await fs.stat(stale)).isDirectory(), true);
  });
}

async function testCleanupRemovesStaleSnapshotDirectoriesWithApply() {
  await withTempWorkspace(async (alyceDirectory) => {
    const staleGit = path.join(alyceDirectory, "snapshots", "git", "stale-git");
    const freshGit = path.join(alyceDirectory, "snapshots", "git", "fresh-git");
    const staleHistory = path.join(alyceDirectory, "file-history", "stale-session");
    await Promise.all([
      fs.mkdir(staleGit, { recursive: true }),
      fs.mkdir(freshGit, { recursive: true }),
      fs.mkdir(staleHistory, { recursive: true })
    ]);
    await makeOld(staleGit);
    await makeOld(staleHistory);

    const report = await cleanupSnapshotStorage({
      alyceDirectory,
      retentionDays: 7,
      apply: true,
      now: new Date("2026-05-15T00:00:00.000Z")
    });

    assert.deepEqual(
      report.removed.map((target) => path.basename(target.path)).sort(),
      ["stale-git", "stale-session"]
    );
    await assert.rejects(fs.stat(staleGit), { code: "ENOENT" });
    await assert.rejects(fs.stat(staleHistory), { code: "ENOENT" });
    assert.equal((await fs.stat(freshGit)).isDirectory(), true);
  });
}

async function testCleanupSkipsExcludedSnapshotDirectories() {
  await withTempWorkspace(async (alyceDirectory) => {
    const currentGit = path.join(alyceDirectory, "snapshots", "git", "current-workspace");
    const staleGit = path.join(alyceDirectory, "snapshots", "git", "stale-workspace");
    await Promise.all([
      fs.mkdir(currentGit, { recursive: true }),
      fs.mkdir(staleGit, { recursive: true })
    ]);
    await Promise.all([makeOld(currentGit), makeOld(staleGit)]);

    const report = await cleanupSnapshotStorage({
      alyceDirectory,
      retentionDays: 7,
      apply: true,
      excludePaths: [currentGit],
      now: new Date("2026-05-15T00:00:00.000Z")
    });

    assert.deepEqual(report.removed.map((target) => path.basename(target.path)), ["stale-workspace"]);
    assert.equal((await fs.stat(currentGit)).isDirectory(), true);
    await assert.rejects(fs.stat(staleGit), { code: "ENOENT" });
  });
}

async function makeOld(targetPath: string) {
  const oldDate = new Date("2026-05-01T00:00:00.000Z");
  await fs.utimes(targetPath, oldDate, oldDate);
}

async function withTempWorkspace(callback: (alyceDirectory: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-snapshot-cleanup-"));
  const alyceDirectory = path.join(root, ".alyce");
  try {
    await callback(alyceDirectory);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
