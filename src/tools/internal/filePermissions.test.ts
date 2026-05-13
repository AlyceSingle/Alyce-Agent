import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getAggregateFilePermissionDetails,
  getFilePermissionMetadata,
  getPatchPermissionPattern,
  requestFilePermission,
  requestSensitiveFileReadApproval
} from "./filePermissions.js";
import type { ToolApprovalRequest, ToolExecutionContext } from "../types.js";

type TestContext = ToolExecutionContext & {
  approvalRequests: ToolApprovalRequest[];
};

async function runTests() {
  testWorkspacePathPatternUsesForwardSlashes();
  testSensitiveEnvPathForcesAsk();
  testAlyceInternalPathIsSensitive();
  testGeneratedPathForcesAsk();
  await testSensitiveReadRequestsFileReadPermission();
  await testNormalReadSkipsApproval();
  await testWorkspaceWriteApprovalCarriesFileWritePattern();
  testPatchPatternAggregatesTouchedPaths();
  console.log("filePermissions tests passed");
}

function testWorkspacePathPatternUsesForwardSlashes() {
  const workspaceRoot = path.resolve("D:\\Code\\AlyceAgent");
  const metadata = getFilePermissionMetadata(
    workspaceRoot,
    path.join(workspaceRoot, "src", "index.ts")
  );

  assert.equal(metadata.displayPath, path.join("src", "index.ts"));
  assert.equal(metadata.permissionPattern, "workspace:src/index.ts");
  assert.equal(metadata.forceAsk, false);
}

function testSensitiveEnvPathForcesAsk() {
  const workspaceRoot = path.resolve("D:\\Code\\AlyceAgent");
  const metadata = getFilePermissionMetadata(workspaceRoot, path.join(workspaceRoot, ".env.local"));

  assert.equal(metadata.permissionPattern, "sensitive:.env.local");
  assert.equal(metadata.forceAsk, true);
  assert.match(metadata.sensitiveReasons.join("\n"), /environment files/);
}

function testAlyceInternalPathIsSensitive() {
  const workspaceRoot = path.resolve("D:\\Code\\AlyceAgent");
  const metadata = getFilePermissionMetadata(
    workspaceRoot,
    path.join(workspaceRoot, ".alyce", "config.json")
  );

  assert.equal(metadata.forceAsk, true);
  assert.match(metadata.sensitiveReasons.join("\n"), /Alyce internal state/);
}

function testGeneratedPathForcesAsk() {
  const workspaceRoot = path.resolve("D:\\Code\\AlyceAgent");
  const metadata = getFilePermissionMetadata(
    workspaceRoot,
    path.join(workspaceRoot, "dist", "index.js")
  );

  assert.equal(metadata.permissionPattern, "workspace:dist/index.js");
  assert.equal(metadata.forceAsk, true);
  assert.match(metadata.generatedReasons.join("\n"), /dist/);
}

async function testSensitiveReadRequestsFileReadPermission() {
  const context = await createTestContext();
  try {
    const envPath = path.join(context.workspaceRoot, ".env");
    await fs.writeFile(envPath, "OPENAI_API_KEY=test\n", "utf8");

    await requestSensitiveFileReadApproval(context, envPath, {
      toolName: "Read",
      actionLabel: "read file"
    });

    assert.equal(context.approvalRequests.length, 1);
    assert.equal(context.approvalRequests[0]?.kind, "file-read");
    assert.deepEqual(context.approvalRequests[0]?.permission, {
      permission: "file.read",
      pattern: "sensitive:.env"
    });
    assert.equal(context.approvalRequests[0]?.forceAsk, true);
  } finally {
    await cleanupContext(context);
  }
}

async function testNormalReadSkipsApproval() {
  const context = await createTestContext();
  try {
    const sourcePath = path.join(context.workspaceRoot, "src", "index.ts");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "export {};\n", "utf8");

    await requestSensitiveFileReadApproval(context, sourcePath, {
      toolName: "Read"
    });

    assert.equal(context.approvalRequests.length, 0);
  } finally {
    await cleanupContext(context);
  }
}

async function testWorkspaceWriteApprovalCarriesFileWritePattern() {
  const context = await createTestContext();
  try {
    const targetPath = path.join(context.workspaceRoot, "src", "created.ts");
    await requestFilePermission(context, targetPath, {
      toolName: "Write",
      permission: "file.write",
      actionLabel: "create file"
    });

    assert.equal(context.approvalRequests.length, 1);
    assert.equal(context.approvalRequests[0]?.kind, "file-write");
    assert.deepEqual(context.approvalRequests[0]?.permission, {
      permission: "file.write",
      pattern: "workspace:src/created.ts"
    });
  } finally {
    await cleanupContext(context);
  }
}

function testPatchPatternAggregatesTouchedPaths() {
  const workspaceRoot = path.resolve("D:\\Code\\AlyceAgent");
  const sourcePath = path.join(workspaceRoot, "src", "a.ts");
  const envPath = path.join(workspaceRoot, ".env");
  const pattern = getPatchPermissionPattern(workspaceRoot, [sourcePath, envPath]);
  const details = getAggregateFilePermissionDetails(workspaceRoot, [sourcePath, envPath]);

  assert.match(pattern, /^patch:/);
  assert.match(pattern, /workspace:src\/a\.ts/);
  assert.match(pattern, /sensitive:\.env/);
  assert.equal(details.forceAsk, true);
}

async function createTestContext(): Promise<TestContext> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "alyce-file-permissions-"));
  const abortController = new AbortController();
  const approvalRequests: ToolApprovalRequest[] = [];
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
    recordFileRead: () => undefined,
    getFileReadState: () => undefined,
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
