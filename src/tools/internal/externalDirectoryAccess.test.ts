import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveReadablePathWithExternalApproval,
  resolveWritablePathWithExternalApproval
} from "./externalDirectoryAccess.js";
import type { ToolApprovalRequest, ToolExecutionContext } from "../types.js";

type TestContext = ToolExecutionContext & {
  approvalRequests: ToolApprovalRequest[];
};

async function createTestContext(options: {
  approvalResult?: boolean;
} = {}): Promise<TestContext & { cleanup: () => Promise<void> }> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "alyce-external-access-workspace-"));
  const abortController = new AbortController();
  const approvalRequests: ToolApprovalRequest[] = [];

  const context: TestContext & { cleanup: () => Promise<void> } = {
    workspaceRoot,
    allowedRoots: [workspaceRoot],
    requestApproval: async (request) => {
      approvalRequests.push(request);
      return options.approvalResult ?? true;
    },
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined,
    approvalRequests,
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  };

  return context;
}

async function runTests() {
  await testWritablePathRequestsApprovalOutsideWorkspace();
  await testWritablePathRejectsWhenApprovalDenied();
  await testReadablePathInsideWorkspaceSkipsApproval();
  await testWritablePathReusesCurrentAllowedRoots();
  console.log("externalDirectoryAccess tests passed");
}

async function testWritablePathRequestsApprovalOutsideWorkspace() {
  const context = await createTestContext({ approvalResult: true });
  const externalDirectory = await fs.mkdtemp(path.join(tmpdir(), "alyce-external-access-outside-"));
  const externalFile = path.join(externalDirectory, "note.txt");

  try {
    const result = await resolveWritablePathWithExternalApproval(context, externalFile, {
      toolName: "Write",
      title: "Write external path",
      kind: "file"
    });

    assert.equal(result.absolutePath, path.resolve(externalFile));
    assert.equal(context.approvalRequests.length, 1);
    assert.equal(context.approvalRequests[0]?.kind, "external-directory");
    assert.equal(context.approvalRequests[0]?.scope?.type, "external-directory");
    assert.equal(context.approvalRequests[0]?.scope?.directory, path.resolve(externalDirectory));
    assert.deepEqual(context.approvalRequests[0]?.permission, {
      permission: "directory.external",
      pattern: path.resolve(externalDirectory)
    });
    assert.match(context.approvalRequests[0]?.details.join("\n") ?? "", /Access: read\/write/);
    assert.equal(
      result.allowedRoots.some((root) => path.resolve(root) === path.resolve(externalDirectory)),
      true
    );
  } finally {
    await fs.rm(externalDirectory, { recursive: true, force: true });
    await context.cleanup();
  }
}

async function testWritablePathRejectsWhenApprovalDenied() {
  const context = await createTestContext({ approvalResult: false });
  const externalDirectory = await fs.mkdtemp(path.join(tmpdir(), "alyce-external-access-denied-"));
  const externalFile = path.join(externalDirectory, "note.txt");

  try {
    await assert.rejects(
      resolveWritablePathWithExternalApproval(context, externalFile, {
        toolName: "Write",
        title: "Write external path",
        kind: "file"
      }),
      /User rejected external directory access/
    );
    assert.equal(context.approvalRequests.length, 1);
  } finally {
    await fs.rm(externalDirectory, { recursive: true, force: true });
    await context.cleanup();
  }
}

async function testReadablePathInsideWorkspaceSkipsApproval() {
  const context = await createTestContext({ approvalResult: true });

  try {
    const result = await resolveReadablePathWithExternalApproval(context, "docs/readme.md", {
      toolName: "Read",
      title: "Read external path",
      kind: "file"
    });

    assert.equal(result.absolutePath, path.resolve(context.workspaceRoot, "docs/readme.md"));
    assert.equal(context.approvalRequests.length, 0);
  } finally {
    await context.cleanup();
  }
}

async function testWritablePathReusesCurrentAllowedRoots() {
  const context = await createTestContext({ approvalResult: true });
  const externalDirectory = await fs.mkdtemp(path.join(tmpdir(), "alyce-external-access-reuse-"));
  const externalFileA = path.join(externalDirectory, "a.txt");
  const externalFileB = path.join(externalDirectory, "b.txt");

  try {
    const first = await resolveWritablePathWithExternalApproval(context, externalFileA, {
      toolName: "Write",
      title: "Write external path",
      kind: "file"
    });
    assert.equal(context.approvalRequests.length, 1);

    const second = await resolveWritablePathWithExternalApproval(context, externalFileB, {
      toolName: "Write",
      title: "Write external path",
      kind: "file",
      currentAllowedRoots: first.allowedRoots
    });
    assert.equal(context.approvalRequests.length, 1);
    assert.equal(second.absolutePath, path.resolve(externalFileB));
  } finally {
    await fs.rm(externalDirectory, { recursive: true, force: true });
    await context.cleanup();
  }
}

void runTests();
