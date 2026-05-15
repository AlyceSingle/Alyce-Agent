import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DiffService,
  formatDiffDetails,
  formatDiffOverview,
  formatPostEditSummary,
  type DiffSummary,
  type TurnDiffReport,
  type WorkingTreeDiffReport
} from "./diffService.js";
import { FileHistoryManager } from "../file-history/fileHistoryManager.js";

async function runTests() {
  await testTurnDiffClassifiesAddedModifiedDeletedFiles();
  await testTurnDiffUsesFinalizedAfterSnapshots();
  await testBinaryTurnDiffDegradesSafely();
  await testWorkingTreeDiffUnavailableOutsideGitRepository();
  testDiffOverviewHandlesNoChangesClearly();
  testDiffDetailsAndPostEditSummaryIncludeFileStats();
  console.log("diffService tests passed");
}

async function testTurnDiffClassifiesAddedModifiedDeletedFiles() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const service = new DiffService({ workspaceRoot, fileHistoryManager: history });
    const modified = path.join(workspaceRoot, "src", "modified.ts");
    const added = path.join(workspaceRoot, "src", "added.ts");
    const deleted = path.join(workspaceRoot, "src", "deleted.ts");
    await fs.mkdir(path.dirname(modified), { recursive: true });
    await fs.writeFile(modified, "const value = 1;\n");
    await fs.writeFile(deleted, "remove me\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", modified);
    await history.captureBeforeWrite("turn-1", added);
    await history.captureBeforeWrite("turn-1", deleted);
    await fs.writeFile(modified, "const value = 2;\n");
    await fs.writeFile(added, "new file\n");
    await fs.unlink(deleted);
    await history.finalizeTurn("turn-1");

    const report = await service.getTurnDiff("turn-1");
    assert.equal(report.summary.filesChanged, 3);
    assert.equal(report.summary.added, 1);
    assert.equal(report.summary.modified, 1);
    assert.equal(report.summary.deleted, 1);
    assert.match(report.unifiedDiff, /diff --git a\/src\/modified\.ts b\/src\/modified\.ts/);
    assert.match(report.unifiedDiff, /-const value = 1;/);
    assert.match(report.unifiedDiff, /\+const value = 2;/);
    assert.match(report.unifiedDiff, /new file mode 100644/);
    assert.match(report.unifiedDiff, /deleted file mode 100644/);
  });
}

async function testTurnDiffUsesFinalizedAfterSnapshots() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const service = new DiffService({ workspaceRoot, fileHistoryManager: history });
    const filePath = path.join(workspaceRoot, "stable.txt");
    await fs.writeFile(filePath, "before\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "after turn\n");
    await history.finalizeTurn("turn-1");
    await fs.writeFile(filePath, "later turn\n");

    const report = await service.getTurnDiff("turn-1");
    assert.match(report.unifiedDiff, /\+after turn/);
    assert.doesNotMatch(report.unifiedDiff, /later turn/);
  });
}

async function testBinaryTurnDiffDegradesSafely() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const service = new DiffService({ workspaceRoot, fileHistoryManager: history });
    const filePath = path.join(workspaceRoot, "asset.bin");
    await fs.writeFile(filePath, Buffer.from([0, 1, 2]));

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, Buffer.from([0, 3, 4]));

    const report = await service.getTurnDiff("turn-1");
    assert.equal(report.summary.binaryFiles, 1);
    assert.match(report.unifiedDiff, /Binary files/);
  });
}

async function testWorkingTreeDiffUnavailableOutsideGitRepository() {
  await withTempWorkspace(async (workspaceRoot) => {
    const service = new DiffService({
      workspaceRoot,
      fileHistoryManager: new FileHistoryManager()
    });
    const report = await service.getWorkingTreeDiff();

    assert.equal(report.kind, "working-tree");
    assert.equal(report.available, false);
    assert.equal(report.summary.filesChanged, 0);
    assert.match(service.formatDiffSummary(report), /unavailable/);
  });
}

function testDiffOverviewHandlesNoChangesClearly() {
  const workingTree: WorkingTreeDiffReport = {
    kind: "working-tree",
    workspaceRoot: "/repo",
    available: true,
    unifiedDiff: "",
    summary: createEmptySummary()
  };

  const overview = formatDiffOverview({ workingTree });
  assert.match(overview, /No Alyce turn file changes tracked yet/);
  assert.match(overview, /Working tree: no git-tracked file changes/);
}

function testDiffDetailsAndPostEditSummaryIncludeFileStats() {
  const report: TurnDiffReport = {
    kind: "turn",
    turnId: "turn-1",
    files: [
      {
        path: "src/example.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        beforeBytes: 12,
        afterBytes: 18,
        binary: false,
        truncated: false,
        unifiedDiff: [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1 +1,2 @@",
          "-old",
          "+new",
          "+line"
        ].join("\n")
      }
    ],
    summary: {
      ...createEmptySummary(),
      filesChanged: 1,
      modified: 1,
      additions: 2,
      deletions: 1
    },
    unifiedDiff: [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+line"
    ].join("\n")
  };

  const details = formatDiffDetails(report);
  assert.match(details, /Alyce Turn Diff: turn-1/);
  assert.match(details, /- src\/example\.ts: modified, \+2 -1/);
  assert.match(details, /Unified diff:/);

  const summary = formatPostEditSummary(report);
  assert.match(summary, /File changes captured for this turn/);
  assert.match(summary, /- src\/example\.ts: modified, \+2 -1/);
  assert.match(summary, /Run \/diff last for the full patch/);
}

function createEmptySummary(): DiffSummary {
  return {
    filesChanged: 0,
    added: 0,
    modified: 0,
    deleted: 0,
    additions: 0,
    deletions: 0,
    binaryFiles: 0,
    truncatedFiles: 0
  };
}

async function withTempWorkspace(callback: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-diff-service-"));
  try {
    await callback(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

void runTests();
