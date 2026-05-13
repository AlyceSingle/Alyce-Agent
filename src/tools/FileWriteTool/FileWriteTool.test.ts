import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeFileWrite } from "./FileWriteTool.js";
import type { FileReadState, ToolApprovalRequest, ToolExecutionContext } from "../types.js";

type TestContext = ToolExecutionContext & {
  approvalRequests: ToolApprovalRequest[];
};

async function runTests() {
  await testWorkspaceWriteCarriesFileWritePermission();
  await testSensitiveWriteForcesApproval();
  console.log("FileWriteTool tests passed");
}

async function testWorkspaceWriteCarriesFileWritePermission() {
  const context = await createTestContext();
  try {
    const result = await executeFileWrite({
      file_path: "notes.txt",
      content: "hello\n"
    }, context);

    assert.equal(result.type, "create");
    assert.equal(await fs.readFile(path.join(context.workspaceRoot, "notes.txt"), "utf8"), "hello\n");
    assert.equal(context.approvalRequests.length, 1);
    assert.deepEqual(context.approvalRequests[0]?.permission, {
      permission: "file.write",
      pattern: "workspace:notes.txt"
    });
    assert.equal(context.approvalRequests[0]?.forceAsk, false);
  } finally {
    await cleanupContext(context);
  }
}

async function testSensitiveWriteForcesApproval() {
  const context = await createTestContext();
  try {
    await executeFileWrite({
      file_path: ".env",
      content: "OPENAI_API_KEY=test\n"
    }, context);

    assert.equal(context.approvalRequests.length, 1);
    assert.deepEqual(context.approvalRequests[0]?.permission, {
      permission: "file.write",
      pattern: "sensitive:.env"
    });
    assert.equal(context.approvalRequests[0]?.forceAsk, true);
    assert.match(context.approvalRequests[0]?.details.join("\n") ?? "", /Sensitive path/);
  } finally {
    await cleanupContext(context);
  }
}

async function createTestContext(): Promise<TestContext> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "alyce-write-tool-"));
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

async function cleanupContext(context: TestContext) {
  await fs.rm(context.workspaceRoot, { recursive: true, force: true });
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
