import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolExecutionContext } from "../types.js";
import { executeLSPTool, __LSP_TOOL_TESTING__ } from "./LSPTool.js";
import { LSP_OPERATION_VALUES, type LSPToolInput } from "./schemas.js";

async function runTests() {
  await testSupportsAllDeclaredOperations();
  testLspObservationStats();
  testSupportedFileDetection();
  console.log("LSPTool tests passed");
}

async function testSupportsAllDeclaredOperations() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "alyce-lsp-test-"));
  try {
    const filePath = path.join(workspaceRoot, "sample.ts");
    await writeFile(
      filePath,
      [
        "export interface Runner {",
        "  run(): string;",
        "}",
        "",
        "export class Worker implements Runner {",
        "  run(): string {",
        "    return helper();",
        "  }",
        "}",
        "",
        "export function helper(): string {",
        "  return \"ok\";",
        "}",
        "",
        "const worker = new Worker();",
        "worker.run();",
        ""
      ].join("\n"),
      "utf8"
    );

    const context = createContext(workspaceRoot);
    const inputs: Record<LSPToolInput["operation"], LSPToolInput> = {
      goToDefinition: { operation: "goToDefinition", filePath, line: 16, character: 8 },
      findReferences: { operation: "findReferences", filePath, line: 11, character: 17 },
      hover: { operation: "hover", filePath, line: 15, character: 7 },
      documentSymbol: { operation: "documentSymbol", filePath },
      workspaceSymbol: { operation: "workspaceSymbol", filePath, query: "Worker", maxResults: 20 },
      goToImplementation: { operation: "goToImplementation", filePath, line: 2, character: 3 },
      prepareCallHierarchy: { operation: "prepareCallHierarchy", filePath, line: 11, character: 17 },
      incomingCalls: { operation: "incomingCalls", filePath, line: 11, character: 17 },
      outgoingCalls: { operation: "outgoingCalls", filePath, line: 6, character: 3 }
    };

    for (const operation of LSP_OPERATION_VALUES) {
      const result = await executeLSPTool(inputs[operation], context);
      assert.equal(result.operation, operation);
      assert.equal(result.backend, "typescript-language-service");
      assert.equal(result.filePath, "sample.ts");
      assert.equal(typeof result.result, "string");
      assert.ok(result.result.length > 0);
      assert.ok(result.backendCapabilities);
      assert.equal(result.backendCapabilities?.supportsDiagnostics, true);
      assert.deepEqual(result.backendCapabilities?.fileSync, {
        change: true,
        save: true,
        close: true
      });
      assert.ok(result.backendCapabilities?.supportedOperations.includes(operation));
      assert.ok(result.backendHealth);
      assert.equal(result.backendHealth?.backend, "typescript-language-service");
      assert.equal(result.backendHealth?.status, "ready");
      assert.ok(result.resultCount === undefined || result.resultCount >= 0);
      assert.ok(result.fileCount === undefined || result.fileCount >= 0);
    }
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

function testLspObservationStats() {
  __LSP_TOOL_TESTING__.resetLspObservationStats();
  __LSP_TOOL_TESTING__.recordLspObservation({
    operation: "hover",
    outcome: "ok",
    durationMs: 12.8,
    resultCount: 1,
    fileCount: 1
  });
  __LSP_TOOL_TESTING__.recordLspObservation({
    operation: "hover",
    outcome: "error",
    durationMs: 7,
    errorMessage: "boom"
  });

  const snapshot = __LSP_TOOL_TESTING__.getLspObservationStatsSnapshot();
  assert.equal(snapshot.totalCalls, 2);
  assert.equal(snapshot.successfulCalls, 1);
  assert.equal(snapshot.failedCalls, 1);
  assert.equal(snapshot.totalDurationMs, 19);
  assert.equal(snapshot.averageDurationMs, 9.5);
  assert.equal(snapshot.maxDurationMs, 12);
  assert.equal(snapshot.lastObservation?.operation, "hover");
  assert.equal(snapshot.lastObservation?.outcome, "error");
  assert.equal(snapshot.operations.find((operation) => operation.operation === "hover")?.totalCalls, 2);
}

function testSupportedFileDetection() {
  assert.equal(__LSP_TOOL_TESTING__.isLspSupportedFile("example.ts"), true);
  assert.equal(__LSP_TOOL_TESTING__.isLspSupportedFile("example.JSX"), true);
  assert.equal(__LSP_TOOL_TESTING__.isLspSupportedFile("example.py"), false);
}

function createContext(workspaceRoot: string): ToolExecutionContext {
  return {
    workspaceRoot,
    allowedRoots: [workspaceRoot],
    requestApproval: async () => true,
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 1_000,
    turnId: "test-turn",
    abortSignal: new AbortController().signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined
  };
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
