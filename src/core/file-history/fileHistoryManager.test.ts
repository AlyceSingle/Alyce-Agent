import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileHistoryManager } from "./fileHistoryManager.js";

async function runTests() {
  await testRestoreTurnRestoresModifiedFile();
  await testRestoreTurnRemovesAddedFile();
  await testRestoreTurnReportsAlreadyRestored();
  await testRestoreTurnReportsMissingSnapshot();
  console.log("fileHistoryManager tests passed");
}

async function testRestoreTurnRestoresModifiedFile() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "example.txt");
    await fs.writeFile(filePath, "before\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "after\n");
    await history.finalizeTurn("turn-1");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, [filePath]);
    assert.deepEqual(result.removed, []);
    assert.equal(result.alreadyRestored, false);
    assert.equal(result.missingSnapshot, false);
    assert.equal(await fs.readFile(filePath, "utf8"), "before\n");
  });
}

async function testRestoreTurnRemovesAddedFile() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "added.txt");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "created\n");
    await history.finalizeTurn("turn-1");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, [filePath]);
    await assert.rejects(fs.stat(filePath), /ENOENT/);
  });
}

async function testRestoreTurnReportsAlreadyRestored() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "example.txt");
    await fs.writeFile(filePath, "before\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "after\n");
    await history.finalizeTurn("turn-1");
    await history.restoreTurn("turn-1");

    const result = await history.restoreTurn("turn-1");
    assert.equal(result.alreadyRestored, true);
    assert.equal(result.missingSnapshot, false);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.equal(history.canRestoreTurn("turn-1"), false);
  });
}

async function testRestoreTurnReportsMissingSnapshot() {
  const history = new FileHistoryManager();
  const result = await history.restoreTurn("missing-turn");
  assert.equal(result.missingSnapshot, true);
  assert.equal(result.alreadyRestored, false);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.removed, []);
}

async function withTempWorkspace(callback: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-file-history-"));
  try {
    await callback(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
