import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeLspRuntimeQueryAsync } from "./LspRuntimeWorkerClient.js";

async function runTests() {
  await testSuccessfulWorkerQuery();
  await testAbortTerminatesWorkerQuery();
  await testTimeoutTerminatesWorkerQuery();
  console.log("LspRuntimeWorkerClient tests passed");
}

async function testSuccessfulWorkerQuery() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-lsp-worker-success-"));
  try {
    const filePath = path.join(workspaceRoot, "sample.ts");
    await writeFile(
      filePath,
      [
        "export function helper(): string {",
        "  return \"ok\";",
        "}",
        "",
        "helper();",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await executeLspRuntimeQueryAsync({
      operation: "documentSymbol",
      filePath,
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      timeoutMs: 30_000
    });

    assert.equal(result.operation, "documentSymbol");
    assert.equal(result.filePath, "sample.ts");
    assert.equal(result.backend, "typescript-language-service");
    assert.equal(result.backendHealth?.status, "ready");
    assert.equal(result.result.includes("helper"), true);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function testAbortTerminatesWorkerQuery() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-lsp-worker-abort-"));
  try {
    const filePath = path.join(workspaceRoot, "sample.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const abortController = new AbortController();
    abortController.abort();

    await assert.rejects(
      () =>
        executeLspRuntimeQueryAsync({
          operation: "documentSymbol",
          filePath,
          workspaceRoot,
          allowedRoots: [workspaceRoot],
          abortSignal: abortController.signal,
          timeoutMs: 30_000
        }),
      /LSP query aborted\./
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function testTimeoutTerminatesWorkerQuery() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-lsp-worker-timeout-"));
  try {
    const filePath = path.join(workspaceRoot, "sample.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    await assert.rejects(
      () =>
        executeLspRuntimeQueryAsync({
          operation: "documentSymbol",
          filePath,
          workspaceRoot,
          allowedRoots: [workspaceRoot],
          timeoutMs: 1
        }),
      /LSP query timed out after 1ms\./
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
