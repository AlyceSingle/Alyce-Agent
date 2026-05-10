import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LspRuntimeService,
  LspRuntimeUnsupportedOperationError
} from "./LspRuntimeService.js";
import type { LspRuntimeAdapter } from "./types.js";

async function runTests() {
  await testBackendSnapshotIncludesCapabilitiesAndHealth();
  await testUnsupportedOperationErrorHasStandardShape();
  await testHealthCheckFailureDoesNotBreakExecution();
  console.log("LspRuntimeService tests passed");
}

async function testBackendSnapshotIncludesCapabilitiesAndHealth() {
  const service = new LspRuntimeService([createStubAdapter()]);
  const snapshots = service.getBackendSnapshot();
  assert.equal(snapshots.length, 1);

  const snapshot = snapshots[0];
  assert.equal(snapshot?.backend, "typescript-language-service");
  assert.deepEqual(snapshot?.capabilities.supportedOperations, ["hover"]);
  assert.equal(snapshot?.capabilities.supportsDiagnostics, false);
  assert.deepEqual(snapshot?.capabilities.fileSync, {
    change: false,
    save: false,
    close: false
  });
  assert.equal(snapshot?.health.status, "degraded");
  assert.equal(snapshot?.health.backend, "typescript-language-service");
}

async function testUnsupportedOperationErrorHasStandardShape() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-lsp-runtime-test-"));
  try {
    const filePath = path.join(workspaceRoot, "sample.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const service = new LspRuntimeService([createStubAdapter()]);
    await assert.rejects(
      () =>
        service.execute({
          operation: "goToDefinition",
          filePath,
          workspaceRoot,
          allowedRoots: [workspaceRoot]
        }),
      (error) => {
        assert.ok(error instanceof LspRuntimeUnsupportedOperationError);
        const data = error.toData();
        assert.equal(data.code, "lsp_unsupported_operation");
        assert.equal(data.backend, "typescript-language-service");
        assert.equal(data.operation, "goToDefinition");
        assert.equal(data.filePath, "sample.ts");
        assert.deepEqual(data.supportedOperations, ["hover"]);
        return true;
      }
    );

    const success = await service.execute({
      operation: "hover",
      filePath,
      workspaceRoot,
      allowedRoots: [workspaceRoot]
    });
    assert.equal(success.backend, "typescript-language-service");
    assert.equal(success.backendCapabilities?.supportsDiagnostics, false);
    assert.equal(success.backendHealth?.status, "degraded");
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function testHealthCheckFailureDoesNotBreakExecution() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-lsp-runtime-health-failure-"));
  try {
    const filePath = path.join(workspaceRoot, "sample.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const service = new LspRuntimeService([createStubAdapter({
      getHealth: () => {
        throw new Error("health probe failed");
      }
    })]);
    const result = await service.execute({
      operation: "hover",
      filePath,
      workspaceRoot,
      allowedRoots: [workspaceRoot]
    });
    assert.equal(result.backendHealth?.status, "degraded");
    assert.equal(
      result.backendHealth?.message?.includes("health probe failed"),
      true
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

function createStubAdapter(
  overrides: Partial<LspRuntimeAdapter> = {}
): LspRuntimeAdapter {
  return {
    backend: "typescript-language-service",
    capabilities: {
      supportedOperations: ["hover"],
      supportsDiagnostics: false,
      fileSync: {
        change: false,
        save: false,
        close: false
      },
      supportedFileExtensions: [".ts"]
    },
    isSupportedFile: (fileName) => path.extname(fileName).toLowerCase() === ".ts",
    supportsOperation: (operation) => operation === "hover",
    execute: () => ({
      result: "ok",
      resultCount: 1,
      fileCount: 1
    }),
    getHealth: () => ({
      backend: "typescript-language-service",
      status: "degraded",
      checkedAt: "2026-05-10T00:00:00.000Z",
      message: "stub"
    }),
    ...overrides
  };
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
