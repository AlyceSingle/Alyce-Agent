import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectGitStatusContext } from "./gitStatusContext.js";

async function runTests() {
  await testCollectsSnapshotInsideGitRepository();
  await testReturnsUndefinedOutsideGitRepository();
  console.log("git status context tests passed");
}

async function testCollectsSnapshotInsideGitRepository() {
  // 本仓库自身就是 git 仓库，直接对它采集。
  const snapshot = await collectGitStatusContext(process.cwd());

  assert.ok(snapshot, "expected a snapshot inside a git repository");
  assert.ok(snapshot.branch.length > 0);
  assert.ok(snapshot.recentCommits.length > 0);
  assert.ok(snapshot.truncatedStatusLines >= 0);
}

async function testReturnsUndefinedOutsideGitRepository() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-git-test-"));
  try {
    const snapshot = await collectGitStatusContext(tempDir);
    assert.equal(snapshot, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
