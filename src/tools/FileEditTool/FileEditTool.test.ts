import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeFileEdit } from "./FileEditTool.js";
import type { FileReadState, ToolApprovalRequest, ToolExecutionContext } from "../types.js";

type TestContext = ToolExecutionContext & {
  approvalRequests: ToolApprovalRequest[];
};

async function runTests() {
  await testStructuredPatchUsesChangedFileLineNumbers();
  console.log("FileEditTool tests passed");
}

async function testStructuredPatchUsesChangedFileLineNumbers() {
  const context = await createTestContext();
  try {
    const filePath = path.join(context.workspaceRoot, "notes.txt");
    await fs.writeFile(filePath, "one\ntwo\nthree\nfour\n");
    await markTextFileRead(context, "notes.txt");

    const result = await executeFileEdit({
      file_path: "notes.txt",
      old_string: "three",
      new_string: "THREE",
      replace_all: false
    }, context);

    assert.deepEqual(result.structuredPatch, [
      {
        oldStart: 2,
        oldLines: 3,
        newStart: 2,
        newLines: 3,
        lines: [
          "--- notes.txt",
          "+++ notes.txt",
          "@@ -2,3 +2,3 @@",
          " two",
          "-three",
          "+THREE",
          " four"
        ]
      }
    ]);
  } finally {
    await cleanupContext(context);
  }
}

async function createTestContext(): Promise<TestContext> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "alyce-edit-tool-"));
  const abortController = new AbortController();
  const approvalRequests: ToolApprovalRequest[] = [];
  const readStates = new Map<string, FileReadState>();

  return {
    workspaceRoot,
    allowedRoots: [workspaceRoot],
    requestApproval: async (request) => {
      approvalRequests.push(request);
      return true;
    },
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: (absolutePath, state) => {
      readStates.set(path.resolve(absolutePath), state);
    },
    getFileReadState: (absolutePath) => readStates.get(path.resolve(absolutePath)),
    approvalRequests
  };
}

async function markTextFileRead(context: TestContext, relativePath: string) {
  const absolutePath = path.join(context.workspaceRoot, relativePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const stats = await fs.stat(absolutePath);
  const lineCount = countLines(content);

  context.recordFileRead(absolutePath, {
    kind: "text",
    source: "read",
    displayPath: relativePath,
    readAt: new Date().toISOString(),
    mtimeMs: stats.mtimeMs,
    sizeBytes: stats.size,
    offset: 1,
    totalCount: lineCount,
    returnedCount: lineCount,
    isPartial: false,
    content: content.replace(/\r\n/g, "\n")
  });
}

function countLines(content: string) {
  if (!content) {
    return 0;
  }

  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

async function cleanupContext(context: TestContext) {
  await fs.rm(context.workspaceRoot, { recursive: true, force: true });
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
