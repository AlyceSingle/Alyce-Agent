import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeFileApplyPatch } from "./FileApplyPatchTool.js";
import type { FileReadState, ToolExecutionContext } from "../types.js";

type TestContext = ToolExecutionContext & {
  markRead: (relativePath: string) => Promise<void>;
  setRecordFileRead: (recordFileRead: ToolExecutionContext["recordFileRead"]) => void;
};

async function createTestContext(options: {
  recordFileRead?: ToolExecutionContext["recordFileRead"];
} = {}): Promise<TestContext & { cleanup: () => Promise<void> }> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "alyce-apply-patch-test-"));
  const abortController = new AbortController();
  const readStates = new Map<string, FileReadState>();
  let activeRecordFileRead: ToolExecutionContext["recordFileRead"] = options.recordFileRead ??
    ((absolutePath, state) => {
      readStates.set(pathKey(absolutePath), state);
    });

  const context: TestContext & { cleanup: () => Promise<void> } = {
    workspaceRoot,
    allowedRoots: [workspaceRoot],
    requestApproval: async () => true,
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: (absolutePath, state) => activeRecordFileRead(absolutePath, state),
    getFileReadState: (absolutePath) => readStates.get(pathKey(absolutePath)),
    setRecordFileRead: (recordFileRead) => {
      activeRecordFileRead = recordFileRead;
    },
    markRead: async (relativePath) => {
      const absolutePath = path.join(workspaceRoot, relativePath);
      const content = await fs.readFile(absolutePath, "utf8");
      const stats = await fs.stat(absolutePath);
      const lineCount = countLines(content);
      readStates.set(pathKey(absolutePath), {
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
    },
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  };

  return context;
}

async function runTests() {
  await testUpdateApplies();
  await testAddRollbackOnPostWriteFailure();
  await testUpdateRollbackOnPostWriteFailure();
  await testRenameOnlyMoveWithMatchingTarget();
  await testMoveOverwriteCountsTargetReplacement();
  console.log("FileApplyPatchTool tests passed");
}

async function testUpdateApplies() {
  const context = await createTestContext();
  try {
    await fs.writeFile(path.join(context.workspaceRoot, "a.txt"), "one\ntwo\n");
    await context.markRead("a.txt");

    await executeFileApplyPatch({
      patchText: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-one",
        "+ONE",
        "*** End Patch"
      ].join("\n")
    }, context);

    assert.equal(await fs.readFile(path.join(context.workspaceRoot, "a.txt"), "utf8"), "ONE\ntwo\n");
  } finally {
    await context.cleanup();
  }
}

async function testAddRollbackOnPostWriteFailure() {
  const context = await createTestContext({
    recordFileRead: () => {
      throw new Error("forced record failure");
    }
  });

  try {
    await assert.rejects(
      executeFileApplyPatch({
        patchText: [
          "*** Begin Patch",
          "*** Add File: b.txt",
          "+created",
          "*** End Patch"
        ].join("\n")
      }, context),
      /rolled back filesystem changes/
    );
    await assert.rejects(fs.readFile(path.join(context.workspaceRoot, "b.txt")), { code: "ENOENT" });
  } finally {
    await context.cleanup();
  }
}

async function testUpdateRollbackOnPostWriteFailure() {
  const context = await createTestContext();
  try {
    await fs.writeFile(path.join(context.workspaceRoot, "c.txt"), "old\n");
    await context.markRead("c.txt");
    context.setRecordFileRead(() => {
      throw new Error("forced record failure");
    });

    await assert.rejects(
      executeFileApplyPatch({
        patchText: [
          "*** Begin Patch",
          "*** Update File: c.txt",
          "@@",
          "-old",
          "+new",
          "*** End Patch"
        ].join("\n")
      }, context),
      /rolled back filesystem changes/
    );
    assert.equal(await fs.readFile(path.join(context.workspaceRoot, "c.txt"), "utf8"), "old\n");
  } finally {
    await context.cleanup();
  }
}

async function testRenameOnlyMoveWithMatchingTarget() {
  const context = await createTestContext();
  try {
    await fs.writeFile(path.join(context.workspaceRoot, "move-source.txt"), "same\n");
    await fs.writeFile(path.join(context.workspaceRoot, "move-target.txt"), "same\n");
    await context.markRead("move-source.txt");
    await context.markRead("move-target.txt");

    const result = await executeFileApplyPatch({
      patchText: [
        "*** Begin Patch",
        "*** Update File: move-source.txt",
        "*** Move to: move-target.txt",
        "*** End Patch"
      ].join("\n")
    }, context);

    assert.equal(result.files[0].additions, 0);
    assert.equal(result.files[0].deletions, 0);
    await assert.rejects(fs.readFile(path.join(context.workspaceRoot, "move-source.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(context.workspaceRoot, "move-target.txt"), "utf8"), "same\n");
  } finally {
    await context.cleanup();
  }
}

async function testMoveOverwriteCountsTargetReplacement() {
  const context = await createTestContext();
  try {
    await fs.writeFile(path.join(context.workspaceRoot, "source.txt"), "source\n");
    await fs.writeFile(path.join(context.workspaceRoot, "target.txt"), "target\nextra\n");
    await context.markRead("source.txt");
    await context.markRead("target.txt");

    const result = await executeFileApplyPatch({
      patchText: [
        "*** Begin Patch",
        "*** Update File: source.txt",
        "*** Move to: target.txt",
        "*** End Patch"
      ].join("\n")
    }, context);

    assert.equal(result.files[0].additions, 1);
    assert.equal(result.files[0].deletions, 2);
    assert.equal(await fs.readFile(path.join(context.workspaceRoot, "target.txt"), "utf8"), "source\n");
  } finally {
    await context.cleanup();
  }
}

function countLines(content: string) {
  if (!content) {
    return 0;
  }

  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function pathKey(absolutePath: string) {
  const resolved = path.resolve(absolutePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

void runTests();
