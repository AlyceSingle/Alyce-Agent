import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __TYPESCRIPT_LSP_ADAPTER_TESTING__,
  typescriptLspAdapter
} from "./typescriptAdapter.js";

async function runTests() {
  await testCapacityEvictionUsesLruOrder();
  await testIdleTtlEvictionRunsDuringAccess();
  await testHealthRecoversAfterTransientCachePressure();
  await testSyncFileSaveDoesNotCrossWorkspaceProjects();
  await testCloseSyncEvictsEmptyProject();
  console.log("typescriptAdapter tests passed");
}

async function testCapacityEvictionUsesLruOrder() {
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.resetStateForTesting();
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.setCachePolicyForTesting({
    maxProjects: 2,
    idleTtlMs: 60_000
  });

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-ts-adapter-capacity-"));
  try {
    const first = path.join(workspaceRoot, "first.ts");
    const second = path.join(workspaceRoot, "second.ts");
    const third = path.join(workspaceRoot, "third.ts");
    await Promise.all([
      writeFile(first, "export const first = 1;\n", "utf8"),
      writeFile(second, "export const second = 2;\n", "utf8"),
      writeFile(third, "export const third = 3;\n", "utf8")
    ]);

    getDiagnostics(first, workspaceRoot);
    getDiagnostics(second, workspaceRoot);
    getDiagnostics(third, workspaceRoot);

    const snapshot = __TYPESCRIPT_LSP_ADAPTER_TESTING__.getCacheSnapshotForTesting();
    assert.equal(snapshot.activeProjectCount, 2);
    assert.equal(snapshot.stats.capacityEvictions, 1);
    assert.equal(snapshot.stats.cacheMisses, 3);
    assert.equal(snapshot.cacheKeys.some((cacheKey) => cacheKey.includes("first.ts")), false);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function testIdleTtlEvictionRunsDuringAccess() {
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.resetStateForTesting();
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.setCachePolicyForTesting({
    maxProjects: 4,
    idleTtlMs: 30
  });

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-ts-adapter-stale-"));
  try {
    const stale = path.join(workspaceRoot, "stale.ts");
    const fresh = path.join(workspaceRoot, "fresh.ts");
    await Promise.all([
      writeFile(stale, "export const stale = 1;\n", "utf8"),
      writeFile(fresh, "export const fresh = 2;\n", "utf8")
    ]);

    getDiagnostics(stale, workspaceRoot);
    await sleep(50);
    getDiagnostics(fresh, workspaceRoot);

    const snapshot = __TYPESCRIPT_LSP_ADAPTER_TESTING__.getCacheSnapshotForTesting();
    assert.equal(snapshot.stats.staleEvictions >= 1, true);
    assert.equal(snapshot.cacheKeys.some((cacheKey) => cacheKey.includes("stale.ts")), false);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function testCloseSyncEvictsEmptyProject() {
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.resetStateForTesting();
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.setCachePolicyForTesting({
    maxProjects: 4,
    idleTtlMs: 60_000
  });

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-ts-adapter-close-"));
  try {
    const filePath = path.join(workspaceRoot, "close.ts");
    await writeFile(filePath, "export const close = true;\n", "utf8");

    getDiagnostics(filePath, workspaceRoot);
    typescriptLspAdapter.syncFileClose?.({
      filePath,
      absolutePath: filePath,
      workspaceRoot,
      allowedRoots: [workspaceRoot]
    });

    const snapshot = __TYPESCRIPT_LSP_ADAPTER_TESTING__.getCacheSnapshotForTesting();
    assert.equal(snapshot.activeProjectCount, 0);
    assert.equal(snapshot.stats.closeEvictions, 1);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function testHealthRecoversAfterTransientCachePressure() {
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.resetStateForTesting();
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.setCachePolicyForTesting({
    maxProjects: 10,
    idleTtlMs: 30
  });

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-ts-adapter-health-"));
  try {
    const stale = path.join(workspaceRoot, "health-stale.ts");
    const fresh = path.join(workspaceRoot, "health-fresh.ts");
    await Promise.all([
      writeFile(stale, "export const stale = 1;\n", "utf8"),
      writeFile(fresh, "export const fresh = 2;\n", "utf8")
    ]);

    getDiagnostics(stale, workspaceRoot);
    await sleep(50);
    getDiagnostics(fresh, workspaceRoot);

    const degraded = typescriptLspAdapter.getHealth?.();
    assert.equal(degraded?.status, "degraded");

    await sleep(300);
    const recovered = typescriptLspAdapter.getHealth?.();
    assert.equal(recovered?.status, "ready");
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function testSyncFileSaveDoesNotCrossWorkspaceProjects() {
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.resetStateForTesting();
  __TYPESCRIPT_LSP_ADAPTER_TESTING__.setCachePolicyForTesting({
    maxProjects: 10,
    idleTtlMs: 60_000
  });

  const parentRoot = await mkdtemp(path.join(tmpdir(), "alyce-ts-adapter-workspace-"));
  const workspaceA = path.join(parentRoot, "workspace-a");
  const workspaceB = path.join(parentRoot, "workspace-b");
  try {
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
    const fileA = path.join(workspaceA, "a.ts");
    const fileB = path.join(workspaceB, "b.ts");
    const newA = path.join(workspaceA, "new-a.ts");
    await Promise.all([
      writeFile(fileA, "export const a = 1;\n", "utf8"),
      writeFile(fileB, "export const b = 2;\n", "utf8"),
      writeFile(newA, "export const newA = 3;\n", "utf8")
    ]);

    getDiagnostics(fileA, workspaceA, [parentRoot]);
    getDiagnostics(fileB, workspaceB, [parentRoot]);
    typescriptLspAdapter.syncFileSave?.({
      filePath: newA,
      absolutePath: newA,
      workspaceRoot: workspaceA,
      allowedRoots: [parentRoot]
    });

    const snapshot = __TYPESCRIPT_LSP_ADAPTER_TESTING__.getCacheSnapshotForTesting();
    const projectA = snapshot.projects.find((project) => project.workspaceRoot === workspaceA);
    const projectB = snapshot.projects.find((project) => project.workspaceRoot === workspaceB);
    assert.ok(projectA);
    assert.ok(projectB);
    assert.equal(projectA.rootFileNames.some((fileName) => fileName.endsWith("new-a.ts")), true);
    assert.equal(projectB.rootFileNames.some((fileName) => fileName.endsWith("new-a.ts")), false);
  } finally {
    await rm(parentRoot, { force: true, recursive: true });
  }
}

function getDiagnostics(filePath: string, workspaceRoot: string, allowedRoots = [workspaceRoot]) {
  const diagnostics = typescriptLspAdapter.getDiagnostics?.({
    filePath,
    absolutePath: filePath,
    workspaceRoot,
    allowedRoots
  });
  assert.ok(diagnostics);
  return diagnostics;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
