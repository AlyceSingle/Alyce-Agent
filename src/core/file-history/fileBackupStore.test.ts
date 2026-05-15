import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileHistoryManager } from "./fileHistoryManager.js";
import { FileBackupStore } from "./fileBackupStore.js";

async function runTests() {
  await testPersistsAndHydratesFileHistorySnapshot();
  await testHydratedSnapshotRestoresAddedAndDeletedFiles();
  await testHydratedSnapshotRestoresDeletedDirectory();
  console.log("fileBackupStore tests passed");
}

async function testPersistsAndHydratesFileHistorySnapshot() {
  await withTempWorkspace(async ({ workspaceRoot, historyRoot }) => {
    const filePath = path.join(workspaceRoot, "example.txt");
    await fs.writeFile(filePath, "before\n");
    const history = new FileHistoryManager();
    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", filePath);
    await fs.writeFile(filePath, "after\n");
    await history.finalizeTurn("turn-1");

    const store = new FileBackupStore({
      rootDirectory: historyRoot,
      sessionId: "session-1"
    });
    const snapshot = history.getSnapshot("turn-1");
    assert.ok(snapshot);
    const persisted = await store.writeSnapshot(snapshot);

    const hydrated = await store.loadSessionSnapshots([persisted]);
    const restoredHistory = new FileHistoryManager();
    restoredHistory.hydrateSnapshots(hydrated);
    const diff = restoredHistory.getFileSnapshotsForTurn("turn-1");

    assert.equal(diff.length, 1);
    assert.equal(diff[0]?.absolutePath, filePath);
    assert.equal(diff[0]?.before.content.toString("utf8"), "before\n");
    assert.equal(diff[0]?.after.content.toString("utf8"), "after\n");
    assert.equal(diff[0]?.changeKind, "modified");
  });
}

async function testHydratedSnapshotRestoresAddedAndDeletedFiles() {
  await withTempWorkspace(async ({ workspaceRoot, historyRoot }) => {
    const addedPath = path.join(workspaceRoot, "added.txt");
    const deletedPath = path.join(workspaceRoot, "deleted.txt");
    await fs.writeFile(deletedPath, "delete me\n");
    const history = new FileHistoryManager();
    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", addedPath);
    await history.captureBeforeWrite("turn-1", deletedPath);
    await fs.writeFile(addedPath, "created\n");
    await fs.unlink(deletedPath);
    await history.finalizeTurn("turn-1");

    const store = new FileBackupStore({
      rootDirectory: historyRoot,
      sessionId: "session-1"
    });
    const snapshot = history.getSnapshot("turn-1");
    assert.ok(snapshot);
    await store.writeSnapshot(snapshot);

    const restoredHistory = new FileHistoryManager();
    restoredHistory.hydrateSnapshots(await store.loadSessionSnapshots());
    const result = await restoredHistory.restoreTurn("turn-1");

    assert.deepEqual(result.restored, [deletedPath]);
    assert.deepEqual(result.removed, [addedPath]);
    assert.equal(await fs.readFile(deletedPath, "utf8"), "delete me\n");
    await assert.rejects(fs.stat(addedPath), { code: "ENOENT" });
  });
}

async function testHydratedSnapshotRestoresDeletedDirectory() {
  await withTempWorkspace(async ({ workspaceRoot, historyRoot }) => {
    const directoryPath = path.join(workspaceRoot, "deleted-directory");
    const nestedFile = path.join(directoryPath, "nested", "note.txt");
    const linkPath = path.join(directoryPath, "note-link.txt");
    await fs.mkdir(path.dirname(nestedFile), { recursive: true });
    await fs.writeFile(nestedFile, "before\n");
    const symlinkCreated = await tryCreateSymlink(path.join("nested", "note.txt"), linkPath, "file");
    const history = new FileHistoryManager();
    history.beginTurn("turn-1");
    await history.captureBeforeWrite("turn-1", directoryPath);
    await fs.rm(directoryPath, { recursive: true, force: true });
    await history.finalizeTurn("turn-1");

    const store = new FileBackupStore({
      rootDirectory: historyRoot,
      sessionId: "session-1"
    });
    const snapshot = history.getSnapshot("turn-1");
    assert.ok(snapshot);
    const persisted = await store.writeSnapshot(snapshot);
    assert.equal(persisted.version, 2);
    assert.equal(persisted.files[0]?.kind, "directory");

    const restoredHistory = new FileHistoryManager();
    restoredHistory.hydrateSnapshots(await store.loadSessionSnapshots());
    const result = await restoredHistory.restoreTurn("turn-1");

    assert.deepEqual(result.restored, [directoryPath]);
    assert.deepEqual(result.removed, []);
    assert.equal(await fs.readFile(nestedFile, "utf8"), "before\n");
    if (symlinkCreated) {
      assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
      assert.equal(await fs.readlink(linkPath), path.join("nested", "note.txt"));
    }
  });
}

async function withTempWorkspace(callback: (paths: {
  workspaceRoot: string;
  historyRoot: string;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-file-backup-store-"));
  const workspaceRoot = path.join(root, "workspace");
  const historyRoot = path.join(root, "file-history");
  await fs.mkdir(workspaceRoot, { recursive: true });
  try {
    await callback({ workspaceRoot, historyRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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
