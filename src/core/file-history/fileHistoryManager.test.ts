import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileHistoryManager } from "./fileHistoryManager.js";

async function runTests() {
  await testRestoreTurnRestoresModifiedFile();
  await testRestoreTurnRestoresDeletedFile();
  await testRestoreTurnRemovesAddedFile();
  await testRestoreTurnRemovesAddedEmptyFile();
  await testRestoreTurnSkipsModifiedFileConflict();
  await testRestoreTurnSkipsAddedFileConflict();
  await testRestoreTurnSkipsDeletedFileConflict();
  await testRestoreTurnRemovesAddedDirectory();
  await testRestoreTurnRestoresDeletedDirectory();
  await testRestoreTurnRestoresDeletedDirectorySymlinkEntry();
  await testRestoreTurnSkipsAddedDirectoryConflict();
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

async function testRestoreTurnRestoresDeletedFile() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "deleted.txt");
    await fs.writeFile(filePath, "original\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.unlink(filePath);
    const changedFiles = await history.finalizeTurn("turn-1");

    assert.deepEqual(changedFiles, [{
      absolutePath: filePath,
      changeKind: "deleted",
      beforeBytes: Buffer.byteLength("original\n"),
      afterBytes: 0
    }]);

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, [filePath]);
    assert.deepEqual(result.removed, []);
    assert.equal(await fs.readFile(filePath, "utf8"), "original\n");
  });
}

async function testRestoreTurnRemovesAddedEmptyFile() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "empty.txt");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "");
    const changedFiles = await history.finalizeTurn("turn-1");

    assert.deepEqual(changedFiles, [{
      absolutePath: filePath,
      changeKind: "added",
      beforeBytes: 0,
      afterBytes: 0
    }]);

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, [filePath]);
    await assert.rejects(fs.stat(filePath), /ENOENT/);
  });
}

async function testRestoreTurnSkipsModifiedFileConflict() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "conflict-modified.txt");
    await fs.writeFile(filePath, "before\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "after\n");
    await history.finalizeTurn("turn-1");
    await fs.writeFile(filePath, "user change\n");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.conflicts, [{
      absolutePath: filePath,
      changeKind: "modified",
      reason: "current-content-changed"
    }]);
    assert.equal(result.restoredAt, undefined);
    assert.equal(history.canRestoreTurn("turn-1"), true);
    assert.equal(await fs.readFile(filePath, "utf8"), "user change\n");
  });
}

async function testRestoreTurnSkipsAddedFileConflict() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "conflict-added.txt");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "created\n");
    await history.finalizeTurn("turn-1");
    await fs.writeFile(filePath, "user change\n");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.conflicts, [{
      absolutePath: filePath,
      changeKind: "added",
      reason: "current-content-changed"
    }]);
    assert.equal(await fs.readFile(filePath, "utf8"), "user change\n");
  });
}

async function testRestoreTurnSkipsDeletedFileConflict() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const filePath = path.join(workspaceRoot, "conflict-deleted.txt");
    await fs.writeFile(filePath, "before\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.unlink(filePath);
    await history.finalizeTurn("turn-1");
    await fs.writeFile(filePath, "user recreated\n");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.conflicts, [{
      absolutePath: filePath,
      changeKind: "deleted",
      reason: "current-file-recreated"
    }]);
    assert.equal(await fs.readFile(filePath, "utf8"), "user recreated\n");
  });
}

async function testRestoreTurnRemovesAddedDirectory() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const directoryPath = path.join(workspaceRoot, "created-directory");
    const filePath = path.join(directoryPath, "note.txt");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", directoryPath);
    await fs.mkdir(directoryPath);
    await fs.writeFile(filePath, "created\n");
    const changedFiles = await history.finalizeTurn("turn-1");

    assert.equal(changedFiles.length, 1);
    assert.equal(changedFiles[0]?.absolutePath, directoryPath);
    assert.equal(changedFiles[0]?.changeKind, "added");
    assert.equal(history.hasTrackedFiles("turn-1"), true);
    assert.equal(history.canRestoreTurn("turn-1"), true);

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, [directoryPath]);
    await assert.rejects(fs.stat(directoryPath), /ENOENT/);
  });
}

async function testRestoreTurnRestoresDeletedDirectory() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const directoryPath = path.join(workspaceRoot, "deleted-directory");
    const nestedDirectory = path.join(directoryPath, "nested");
    const filePath = path.join(nestedDirectory, "note.txt");
    await fs.mkdir(nestedDirectory, { recursive: true });
    await fs.writeFile(filePath, "before\n");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", directoryPath);
    await fs.rm(directoryPath, { recursive: true, force: true });
    const changedFiles = await history.finalizeTurn("turn-1");

    assert.equal(changedFiles.length, 1);
    assert.equal(changedFiles[0]?.absolutePath, directoryPath);
    assert.equal(changedFiles[0]?.changeKind, "deleted");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, [directoryPath]);
    assert.deepEqual(result.removed, []);
    assert.equal(await fs.readFile(filePath, "utf8"), "before\n");
  });
}

async function testRestoreTurnRestoresDeletedDirectorySymlinkEntry() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const directoryPath = path.join(workspaceRoot, "deleted-directory-with-link");
    const targetPath = path.join(directoryPath, "target.txt");
    const linkPath = path.join(directoryPath, "link.txt");
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(targetPath, "target\n");
    const symlinkCreated = await tryCreateSymlink("target.txt", linkPath, "file");
    if (!symlinkCreated) {
      return;
    }

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", directoryPath);
    await fs.rm(directoryPath, { recursive: true, force: true });
    await history.finalizeTurn("turn-1");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, [directoryPath]);
    assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(linkPath), "target.txt");
    assert.equal(await fs.readFile(linkPath, "utf8"), "target\n");
  });
}

async function testRestoreTurnSkipsAddedDirectoryConflict() {
  await withTempWorkspace(async (workspaceRoot) => {
    const history = new FileHistoryManager();
    const directoryPath = path.join(workspaceRoot, "conflict-directory");
    const filePath = path.join(directoryPath, "note.txt");

    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", directoryPath);
    await fs.mkdir(directoryPath);
    await fs.writeFile(filePath, "created\n");
    await history.finalizeTurn("turn-1");
    await fs.writeFile(path.join(directoryPath, "user.txt"), "user change\n");

    const result = await history.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.conflicts, [{
      absolutePath: directoryPath,
      changeKind: "added",
      reason: "current-content-changed"
    }]);
    assert.equal(await fs.readFile(filePath, "utf8"), "created\n");
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

async function tryCreateSymlink(
  target: string,
  linkPath: string,
  type: "file" | "dir" | "junction"
) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (isSymlinkUnavailableError(error)) {
      return false;
    }

    throw error;
  }
}

function isSymlinkUnavailableError(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ["EACCES", "EPERM", "ENOTSUP"].includes((error as { code?: string }).code ?? "")
  );
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
