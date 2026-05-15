import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PtyManager } from "../../core/pty/ptyManager.js";
import { executeToolCall } from "../executeToolCall.js";
import { getToolPolicyViolation, isToolSchemaAllowedByPolicy } from "../toolPolicy.js";
import type { ToolApprovalRequest, ToolExecutionContext } from "../types.js";

async function runTests() {
  await testPtyCreateReadWriteResizeAndClose();
  await testPtyCreateMissingCwdFailsBeforeApproval();
  await testPlanModeBlocksMutatingPtyTools();
  await testPlanModeAllowsPtyListAndRead();
  testToolPolicyKeepsSubagentPtyReadOnly();
  console.log("pty tool tests passed");
}

async function testPtyCreateReadWriteResizeAndClose() {
  await withPtyContext(async ({ context, manager, approvals }) => {
    const created = parseSuccess<{
      pty_id: string;
      status: string;
      title: string;
      pid: number | null;
    }>(
      await executeToolCall(
        "PtyCreate",
        JSON.stringify({
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdout.write('ready\\n');",
              "process.stdin.setEncoding('utf8');",
              "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
              "process.stdin.resume();",
              "process.stdin.on('data', (chunk) => process.stdout.write('echo:' + chunk));"
            ].join("")
          ],
          title: "node fixture",
          cols: 80,
          rows: 24
        }),
        context
      )
    );

    assert.equal(created.status, "running");
    assert.equal(created.title, "node fixture");
    assert.ok(created.pid === null || created.pid > 0);
    assert.equal(approvals[0]?.kind, "command");
    assert.equal(approvals[0]?.toolName, "PtyCreate");

    const firstRead = await waitForToolContent(context, created.pty_id, /ready/);
    assert.match(firstRead.content, /ready/);

    const written = parseSuccess<{ bytes: number; pty_id: string }>(
      await executeToolCall(
        "PtyWrite",
        JSON.stringify({ pty_id: created.pty_id, data: "hello\n" }),
        context
      )
    );
    assert.equal(written.pty_id, created.pty_id);
    assert.equal(written.bytes, 6);
    assert.equal(approvals[1]?.toolName, "PtyWrite");
    assert.equal(approvals[1]?.forceAsk, true);
    assert.match(approvals[1]?.permission?.pattern ?? "", /hello\n$/);

    const echoed = await waitForToolContent(context, created.pty_id, /echo:hello/);
    assert.match(echoed.content, /echo:hello/);

    const resized = parseSuccess<{ cols: number; rows: number }>(
      await executeToolCall(
        "PtyResize",
        JSON.stringify({ pty_id: created.pty_id, cols: 100, rows: 30 }),
        context
      )
    );
    assert.equal(resized.cols, 100);
    assert.equal(resized.rows, 30);
    assert.equal(manager.getSession(created.pty_id)?.cols, 100);

    const closed = parseSuccess<{ status: string; pty_id: string }>(
      await executeToolCall(
        "PtyClose",
        JSON.stringify({ pty_id: created.pty_id }),
        context
      )
    );
    assert.equal(closed.status, "closed");
    assert.equal(closed.pty_id, created.pty_id);
    assert.equal(manager.getSession(created.pty_id), undefined);
  });
}

async function testPtyCreateMissingCwdFailsBeforeApproval() {
  await withPtyContext(async ({ context, manager, approvals }) => {
    const result = await executeToolCall(
      "PtyCreate",
      JSON.stringify({
        command: process.execPath,
        args: ["-e", "console.log('should-not-run')"],
        cwd: "missing"
      }),
      context
    );
    const parsed = JSON.parse(result.displayResult) as {
      ok: boolean;
      error: { type: string; message: string };
    };

    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.type, "tool_execution_error");
    assert.match(parsed.error.message, /Working directory does not exist/);
    assert.deepEqual(manager.listSessions(), []);
    assert.deepEqual(approvals, []);
  });
}

async function testPlanModeBlocksMutatingPtyTools() {
  await withPtyContext(async ({ context, approvals }) => {
    const create = await executeToolCall(
      "PtyCreate",
      JSON.stringify({
        command: process.execPath,
        args: ["-e", "console.log('blocked')"]
      }),
      {
        ...context,
        planMode: true
      }
    );
    assertPlanDenied(create, /PtyCreate is blocked in Plan Mode/);
    assert.deepEqual(approvals, []);

    for (const toolName of ["PtyWrite", "PtyResize", "PtyClose"]) {
      const result = await executeToolCall(
        toolName,
        JSON.stringify(toolName === "PtyResize"
          ? { pty_id: "pty_missing", cols: 80, rows: 24 }
          : toolName === "PtyWrite"
            ? { pty_id: "pty_missing", data: "input\n" }
            : { pty_id: "pty_missing" }),
        {
          ...context,
          planMode: true
        }
      );
      assertPlanDenied(result, new RegExp(`${toolName} is blocked in Plan Mode`));
    }
  });
}

async function testPlanModeAllowsPtyListAndRead() {
  await withPtyContext(async ({ context }) => {
    const created = parseSuccess<{ pty_id: string }>(
      await executeToolCall(
        "PtyCreate",
        JSON.stringify({
          command: process.execPath,
          args: ["-e", "console.log('plan-read-ok'); setInterval(() => undefined, 1000);"]
        }),
        context
      )
    );
    await waitForToolContent(context, created.pty_id, /plan-read-ok/);

    const planContext = {
      ...context,
      planMode: true
    };
    const list = parseSuccess<{ sessions: Array<{ pty_id: string }> }>(
      await executeToolCall("PtyList", JSON.stringify({}), planContext)
    );
    assert.ok(list.sessions.some((session) => session.pty_id === created.pty_id));

    const read = parseSuccess<{ content: string }>(
      await executeToolCall(
        "PtyRead",
        JSON.stringify({ pty_id: created.pty_id, cursor: 0 }),
        planContext
      )
    );
    assert.match(read.content, /plan-read-ok/);
  });
}

function testToolPolicyKeepsSubagentPtyReadOnly() {
  const readOnlyPolicy = {
    allowWrite: false,
    allowNetwork: false,
    shell: "read-only" as const
  };

  assert.equal(isToolSchemaAllowedByPolicy("PtyList", readOnlyPolicy), true);
  assert.equal(isToolSchemaAllowedByPolicy("PtyRead", readOnlyPolicy), true);
  assert.equal(isToolSchemaAllowedByPolicy("PtyCreate", readOnlyPolicy), false);
  assert.equal(isToolSchemaAllowedByPolicy("PtyWrite", readOnlyPolicy), false);
  assert.equal(isToolSchemaAllowedByPolicy("PtyResize", readOnlyPolicy), false);
  assert.equal(isToolSchemaAllowedByPolicy("PtyClose", readOnlyPolicy), false);
  assert.match(
    getToolPolicyViolation("PtyWrite", { pty_id: "pty_test", data: "npm run dev\n" }, readOnlyPolicy) ?? "",
    /interactive PTY mutation/
  );
}

async function withPtyContext(callback: (fixture: {
  context: ToolExecutionContext;
  manager: PtyManager;
  approvals: ToolApprovalRequest[];
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-pty-tool-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const manager = new PtyManager({ workspaceRoot });
  const approvals: ToolApprovalRequest[] = [];
  const abortController = new AbortController();
  const context: ToolExecutionContext = {
    workspaceRoot,
    allowedRoots: [workspaceRoot],
    requestApproval: async (request) => {
      approvals.push(request);
      return true;
    },
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    ptyManager: manager,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined
  };

  try {
    await callback({ context, manager, approvals });
  } finally {
    manager.closeAll();
    await delay(250);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function waitForToolContent(
  context: ToolExecutionContext,
  ptyId: string,
  pattern: RegExp,
  timeoutMs = 5_000
): Promise<{ content: string }> {
  const started = Date.now();
  let lastContent = "";
  while (Date.now() - started < timeoutMs) {
    const read = parseSuccess<{ content: string }>(
      await executeToolCall(
        "PtyRead",
        JSON.stringify({ pty_id: ptyId, cursor: 0 }),
        context
      )
    );
    lastContent = read.content;
    if (pattern.test(lastContent)) {
      return read;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${pattern}; last content:\n${lastContent}`);
}

function assertPlanDenied(result: { displayResult: string }, messagePattern: RegExp) {
  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    error: { type: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "plan_mode_violation");
  assert.match(parsed.error.message, messagePattern);
}

function parseSuccess<TResult>(result: { displayResult: string }): TResult {
  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    result: TResult;
    error?: { message: string };
  };
  assert.equal(parsed.ok, true, parsed.error?.message);
  return parsed.result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
