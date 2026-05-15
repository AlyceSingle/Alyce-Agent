import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackgroundProcessManager } from "../../core/background-process/backgroundProcessManager.js";
import { executeToolCall } from "../executeToolCall.js";
import { getToolPolicyViolation, isToolSchemaAllowedByPolicy } from "../toolPolicy.js";
import type { ToolApprovalRequest, ToolExecutionContext } from "../types.js";

async function runTests() {
  await testProcessStartListReadAndStop();
  await testProcessStartExternalCwdRequestsApproval();
  await testProcessStartMissingCwdFailsBeforeApproval();
  await testProcessStartRejectedExternalCwdDoesNotStart();
  await testProcessStartRejectedCommandDoesNotStart();
  await testPlanModeBlocksProcessStartBeforeApproval();
  await testPlanModeAllowsProcessListAndRead();
  testToolPolicyTreatsProcessStartAsShellCommand();
  console.log("background process tool tests passed");
}

async function testProcessStartListReadAndStop() {
  await withProcessContext(async ({ context, manager }) => {
    const start = await executeToolCall(
      "ProcessStart",
      JSON.stringify({
        command: nodeCommand("console.log('Local: http://localhost:5173/'); setInterval(() => undefined, 1000);"),
        wait_for: ["Local:"],
        startup_timeout_ms: 5_000,
        label: "vite fixture"
      }),
      context
    );
    const started = parseSuccess<{
      status: string;
      process_id: string;
      detected_urls: string[];
      detected_ports: number[];
      label: string;
    }>(start);

    assert.equal(started.status, "running");
    assert.equal(started.label, "vite fixture");
    assert.deepEqual(started.detected_urls, ["http://localhost:5173/"]);
    assert.deepEqual(started.detected_ports, [5173]);

    const list = parseSuccess<{ processes: Array<{ process_id: string; status: string }> }>(
      await executeToolCall("ProcessList", JSON.stringify({}), context)
    );
    assert.deepEqual(list.processes.map((process) => process.process_id), [started.process_id]);

    const read = parseSuccess<{ content: string; eof: boolean }>(
      await executeToolCall(
        "ProcessRead",
        JSON.stringify({ process_id: started.process_id, tail_lines: 20 }),
        context
      )
    );
    assert.match(read.content, /Local: http:\/\/localhost:5173\//);
    assert.equal(read.eof, true);

    const stop = parseSuccess<{ status: string; process_id: string }>(
      await executeToolCall(
        "ProcessStop",
        JSON.stringify({ process_id: started.process_id }),
        context
      )
    );
    assert.equal(stop.status, "stopped");
    assert.equal(manager.getProcess(started.process_id)?.status, "stopped");
  });
}

async function testProcessStartExternalCwdRequestsApproval() {
  await withProcessContext(async ({ context, approvals }) => {
    await withExternalTempDirectory(async (externalDirectory) => {
      const result = parseSuccess<{ status: string }>(
        await executeToolCall(
          "ProcessStart",
          JSON.stringify({
            command: nodeCommand("console.log('external-ok')"),
            cwd: externalDirectory,
            startup_timeout_ms: 5_000
          }),
          context
        )
      );

      assert.equal(result.status, "exited");
      assert.equal(approvals[0]?.kind, "external-directory");
      assert.equal(approvals[1]?.kind, "command");
      assert.equal(approvals[1]?.toolName, "ProcessStart");
      assert.match(approvals[1]?.details.join("\n") ?? "", /Mode: background process/);
    });
  });
}

async function testProcessStartMissingCwdFailsBeforeApproval() {
  await withProcessContext(async ({ context, manager, approvals }) => {
    const result = await executeToolCall(
      "ProcessStart",
      JSON.stringify({
        command: nodeCommand("console.log('should-not-run')"),
        cwd: "missing",
        startup_timeout_ms: 5_000
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
    assert.deepEqual(manager.listProcesses({ includeExited: true }), []);
    assert.deepEqual(approvals, []);
  });
}

async function testProcessStartRejectedExternalCwdDoesNotStart() {
  await withProcessContext(async ({ context, manager }) => {
    await withExternalTempDirectory(async (externalDirectory) => {
      const result = await executeToolCall(
        "ProcessStart",
        JSON.stringify({
          command: nodeCommand("console.log('should-not-run')"),
          cwd: externalDirectory,
          startup_timeout_ms: 5_000
        }),
        {
          ...context,
          requestApproval: async (request) => request.kind !== "external-directory"
        }
      );

      const parsed = JSON.parse(result.displayResult) as {
        ok: boolean;
        error: { type: string; message: string };
      };
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.type, "permission_rejected");
      assert.match(parsed.error.message, /external directory access/);
      assert.deepEqual(manager.listProcesses({ includeExited: true }), []);
    });
  });
}

async function testProcessStartRejectedCommandDoesNotStart() {
  await withProcessContext(async ({ context, manager }) => {
    const result = await executeToolCall(
      "ProcessStart",
      JSON.stringify({
        command: nodeCommand("console.log('should-not-run')"),
        startup_timeout_ms: 5_000
      }),
      {
        ...context,
        requestApproval: async (request) => request.kind !== "command"
      }
    );

    const parsed = JSON.parse(result.displayResult) as {
      ok: boolean;
      error: { type: string; message: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.type, "permission_rejected");
    assert.match(parsed.error.message, /ProcessStart/);
    assert.deepEqual(manager.listProcesses({ includeExited: true }), []);
  });
}

async function testPlanModeBlocksProcessStartBeforeApproval() {
  await withProcessContext(async ({ context, approvals }) => {
    const result = await executeToolCall(
      "ProcessStart",
      JSON.stringify({
        command: nodeCommand("console.log('blocked')"),
        startup_timeout_ms: 5_000
      }),
      {
        ...context,
        planMode: true
      }
    );

    const parsed = JSON.parse(result.displayResult) as {
      ok: boolean;
      error: { type: string; message: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.type, "plan_mode_violation");
    assert.match(parsed.error.message, /ProcessStart is blocked in Plan Mode/);
    assert.deepEqual(approvals, []);
  });
}

async function testPlanModeAllowsProcessListAndRead() {
  await withProcessContext(async ({ context }) => {
    const started = parseSuccess<{ process_id: string }>(
      await executeToolCall(
        "ProcessStart",
        JSON.stringify({
          command: nodeCommand("console.log('plan-read-ok')"),
          startup_timeout_ms: 5_000
        }),
        context
      )
    );
    const planContext = {
      ...context,
      planMode: true
    };

    const list = parseSuccess<{ processes: Array<{ process_id: string }> }>(
      await executeToolCall("ProcessList", JSON.stringify({ include_exited: true }), planContext)
    );
    assert.ok(list.processes.some((process) => process.process_id === started.process_id));

    const read = parseSuccess<{ content: string }>(
      await executeToolCall(
        "ProcessRead",
        JSON.stringify({ process_id: started.process_id, tail_lines: 10 }),
        planContext
      )
    );
    assert.match(read.content, /plan-read-ok/);
  });
}

function testToolPolicyTreatsProcessStartAsShellCommand() {
  const readOnlyPolicy = {
    allowWrite: false,
    allowNetwork: false,
    shell: "read-only" as const
  };

  assert.equal(isToolSchemaAllowedByPolicy("ProcessStart", readOnlyPolicy), true);
  assert.equal(isToolSchemaAllowedByPolicy("ProcessStop", readOnlyPolicy), false);
  assert.match(
    getToolPolicyViolation("ProcessStart", { command: "npm run dev" }, readOnlyPolicy) ?? "",
    /read-only shell policy/
  );
}

async function withProcessContext(callback: (fixture: {
  context: ToolExecutionContext;
  manager: BackgroundProcessManager;
  approvals: ToolApprovalRequest[];
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-process-tool-"));
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "background-processes");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const manager = new BackgroundProcessManager({
    workspaceRoot,
    storageRoot,
    defaultStartupTimeoutMs: 1_000
  });
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
    backgroundProcessManager: manager,
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
    await manager.stopAll({ force: true, gracefulTimeoutMs: 500 });
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withExternalTempDirectory(callback: (directory: string) => Promise<void>) {
  const externalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-process-tool-external-"));
  try {
    await callback(externalDirectory);
  } finally {
    await fs.rm(externalDirectory, { recursive: true, force: true });
  }
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

function nodeCommand(script: string): string {
  if (process.platform === "win32") {
    return `& ${powerShellQuote(process.execPath)} -e ${powerShellQuote(script)}`;
  }

  return `${posixQuote(process.execPath)} -e ${posixQuote(script)}`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
