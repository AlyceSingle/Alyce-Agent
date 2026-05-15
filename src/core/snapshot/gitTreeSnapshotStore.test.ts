import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitTreeSnapshotStore } from "./gitTreeSnapshotStore.js";

async function runTests() {
  if (!await GitTreeSnapshotStore.isGitAvailable()) {
    console.log("gitTreeSnapshotStore tests skipped: git unavailable");
    return;
  }

  await testDiffAndRestoreAddedModifiedDeletedFiles();
  await testRestoreFilesSkipsConflicts();
  await testIgnoredFilesAreNotCapturedByDefault();
  console.log("gitTreeSnapshotStore tests passed");
}

async function testDiffAndRestoreAddedModifiedDeletedFiles() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const store = createStore(workspaceRoot, snapshotRoot);
    const modifiedPath = path.join(workspaceRoot, "src", "modified.txt");
    const deletedPath = path.join(workspaceRoot, "src", "deleted.txt");
    const addedPath = path.join(workspaceRoot, "src", "added.txt");
    await fs.mkdir(path.dirname(modifiedPath), { recursive: true });
    await fs.writeFile(modifiedPath, "before\n");
    await fs.writeFile(deletedPath, "delete me\n");

    const before = await store.capture();
    await fs.writeFile(modifiedPath, "after\n");
    await fs.writeFile(addedPath, "created\n");
    await fs.unlink(deletedPath);
    const after = await store.capture();

    const diff = await store.diffSnapshots(before, after);
    assert.deepEqual(
      diff.map((file) => [file.relativePath, file.changeKind]),
      [
        ["src/added.txt", "added"],
        ["src/deleted.txt", "deleted"],
        ["src/modified.txt", "modified"]
      ]
    );

    const result = await store.restoreFiles(before, diff);
    assert.deepEqual(result.restored.sort(), [deletedPath, modifiedPath].sort());
    assert.deepEqual(result.removed, [addedPath]);
    assert.equal(await fs.readFile(modifiedPath, "utf8"), "before\n");
    assert.equal(await fs.readFile(deletedPath, "utf8"), "delete me\n");
    await assert.rejects(fs.stat(addedPath), { code: "ENOENT" });
  });
}

async function testRestoreFilesSkipsConflicts() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const store = createStore(workspaceRoot, snapshotRoot);
    const modifiedPath = path.join(workspaceRoot, "modified.txt");
    const deletedPath = path.join(workspaceRoot, "deleted.txt");
    const addedPath = path.join(workspaceRoot, "added.txt");
    await fs.writeFile(modifiedPath, "before\n");
    await fs.writeFile(deletedPath, "delete me\n");

    const before = await store.capture();
    await fs.writeFile(modifiedPath, "after\n");
    await fs.writeFile(addedPath, "created\n");
    await fs.unlink(deletedPath);
    const after = await store.capture();
    const diff = await store.diffSnapshots(before, after);

    await fs.writeFile(modifiedPath, "user change\n");
    await fs.writeFile(addedPath, "user change\n");
    await fs.writeFile(deletedPath, "user recreated\n");

    const result = await store.restoreFiles(before, diff);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      result.conflicts
        .map((conflict) => [
          path.basename(conflict.absolutePath),
          conflict.changeKind,
          conflict.reason
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      [
        ["added.txt", "added", "current-content-changed"],
        ["deleted.txt", "deleted", "current-file-recreated"],
        ["modified.txt", "modified", "current-content-changed"]
      ]
    );
    assert.equal(await fs.readFile(modifiedPath, "utf8"), "user change\n");
    assert.equal(await fs.readFile(addedPath, "utf8"), "user change\n");
    assert.equal(await fs.readFile(deletedPath, "utf8"), "user recreated\n");
  });
}

async function testIgnoredFilesAreNotCapturedByDefault() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const store = createStore(workspaceRoot, snapshotRoot);
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "ignored.log\n");

    const before = await store.capture();
    await fs.writeFile(path.join(workspaceRoot, "ignored.log"), "ignored\n");
    await fs.writeFile(path.join(workspaceRoot, "visible.log"), "visible\n");
    const after = await store.capture();

    const diff = await store.diffSnapshots(before, after);
    assert.deepEqual(
      diff.map((file) => [file.relativePath, file.changeKind]),
      [["visible.log", "added"]]
    );
  });
}

function createStore(workspaceRoot: string, snapshotRoot: string) {
  return new GitTreeSnapshotStore({
    workspaceRoot,
    gitDirectory: GitTreeSnapshotStore.getWorkspaceSnapshotDirectory(snapshotRoot, workspaceRoot)
  });
}

async function withTempWorkspace(callback: (paths: {
  workspaceRoot: string;
  snapshotRoot: string;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-git-tree-snapshot-"));
  const workspaceRoot = path.join(root, "workspace");
  const snapshotRoot = path.join(root, "snapshots");
  await fs.mkdir(workspaceRoot, { recursive: true });
  try {
    await callback({ workspaceRoot, snapshotRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
