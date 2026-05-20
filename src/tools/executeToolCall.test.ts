import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiffService } from "../core/diff/diffService.js";
import { FileHistoryManager } from "../core/file-history/fileHistoryManager.js";
import { TurnSnapshotService } from "../core/snapshot/turnSnapshotService.js";
import { executeToolCall } from "./executeToolCall.js";
import { getToolPolicyViolation, isToolSchemaAllowedByPolicy } from "./toolPolicy.js";
import type { ToolApprovalRequest, ToolExecutionContext } from "./types.js";

function createTestContext(
  patch: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  const abortController = new AbortController();
  return {
    workspaceRoot: process.cwd(),
    allowedRoots: [process.cwd()],
    requestApproval: async () => true,
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined,
    ...patch
  };
}

async function runTests() {
  await testReadOnlyPolicyAllowsReadOnlyShell();
  await testReadOnlyPolicyAllowsReadOnlyPipelines();
  await testReadOnlyPolicyBlocksWriteShell();
  await testReadOnlyPolicyBlocksWriteLikeReadCommands();
  await testReadOnlyPolicyBlocksWindowsPackageManagerCmdTest();
  await testVerificationPolicyAllowsBuildTestCommands();
  await testVerificationPolicyStillBlocksMutatingCommands();
  await testReadOnlyPolicyBlocksCommandChaining();
  await testAnyShellPolicyBlocksWindowsPackageManagerCmdWhenWriteDisabled();
  await testAnyShellPolicyBlocksWindowsPackageManagerCmdInstallWhenNetworkDisabled();
  await testAnyShellPolicyBlocksNetworkCommandWhenNetworkDisabled();
  await testAnyShellPolicyBlocksCommonNetworkCommands();
  await testPolicyBlocksSubagentOrchestrationTools();
  await testPolicyBlocksMainSessionOnlyTools();
  await testPolicyDoesNotHideInvalidArguments();
  await testRoutesMcpToolCalls();
  await testRoutesCallMcpToolThroughBuiltInTool();
  await testInvalidMcpJsonDoesNotRequestApproval();
  await testNonObjectMcpArgumentsDoNotExecute();
  await testRejectedMcpToolListUsesRejectedStatus();
  await testRejectedMcpResourceListUsesRejectedStatus();
  await testMcpToolRecordsActivityAfterExecution();
  await testRejectedMcpToolDoesNotRecordActivity();
  await testTimedOutMcpToolDoesNotRecordActivity();
  await testPolicyDeniedMcpToolReturnsDeniedStatus();
  await testInvalidArgumentsDoNotRecordToolActivity();
  await testReadOnlyExecutionDoesNotRecordToolActivity();
  await testPlanModeBlocksWriteTools();
  await testPlanModeBlocksArbitraryMcpTools();
  await testPlanModeBlocksMutatingShellBeforeApproval();
  await testPlanModeForcesApprovalForReadOnlyShell();
  await testBashCwdOutsideWorkspaceRequestsExternalDirectoryApproval();
  await testBashCwdOutsideWorkspaceStopsWhenExternalDirectoryRejected();
  await testPowerShellCwdOutsideWorkspaceRequestsExternalDirectoryApproval();
  await testBashFileMutationsDoNotPopulateFileHistory();
  await testPowerShellVariableFileMutationsPopulateFileHistory();
  await testBashDirectoryMutationDoesNotPopulateFileHistoryAsFile();
  await testPowerShellDirectoryMutationDoesNotPopulateFileHistoryAsFile();
  await testBashRedirectionCapturesIgnoredPathInFileHistory();
  await testBashOnWindowsPowerShellCommandCapturesExplicitPath();
  await testPowerShellExplicitPathMutationsPopulateFileHistory();
  await testPowerShellExternalStaticPathMutationPopulatesFileHistory();
  await testPowerShellExternalHomeEnvMutationPopulatesFileHistory();
  await testPowerShellExternalVariableDesktopMutationPopulatesFileHistory();
  await testBashFileMutationsAreCapturedByTurnSnapshot();
  await testPowerShellFileMutationsAreCapturedByTurnSnapshot();
  await testBashTimeoutReturnsStructuredTimeout();
  await testPowerShellTimeoutReturnsStructuredTimeout();
  console.log("executeToolCall tests passed");
}

async function testReadOnlyPolicyAllowsReadOnlyShell() {
  const result = await executeToolCall(
    "PowerShell",
    JSON.stringify({ command: "Get-ChildItem", timeout_ms: 1000 }),
    createTestContext({
      toolPolicy: {
        allowWrite: false,
        allowNetwork: false,
        shell: "read-only"
      }
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean; error?: { type: string } };
  assert.notEqual(parsed.error?.type, "tool_policy_violation");
}

async function testReadOnlyPolicyAllowsReadOnlyPipelines() {
  const violation = getToolPolicyViolation(
    "PowerShell",
    { command: "Get-ChildItem | Select-String package", timeout_ms: 1000 },
    {
      allowWrite: false,
      allowNetwork: false,
      shell: "read-only"
    }
  );

  assert.equal(violation, undefined);
}

async function testReadOnlyPolicyBlocksWriteShell() {
  const result = await executeToolCall(
    "PowerShell",
    JSON.stringify({ command: "Remove-Item test.txt", timeout_ms: 1000 }),
    createTestContext({
      toolPolicy: {
        allowWrite: false,
        allowNetwork: false,
        shell: "read-only"
      }
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean; error: { type: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "tool_policy_violation");
}

async function testReadOnlyPolicyBlocksWriteLikeReadCommands() {
  for (const command of [
    "sed -i s/a/b/g file.txt",
    "sed -i.bak s/a/b/g file.txt",
    "find . -delete",
    "find . -type f -exec rm {} +",
    "git diff --output=patch.txt"
  ]) {
    const violation = getToolPolicyViolation(
      "Bash",
      { command, timeout_ms: 1000 },
      {
        allowWrite: false,
        allowNetwork: false,
        shell: "read-only"
      }
    );

    assert.match(violation ?? "", /read-only shell policy|file writes are disabled/);
  }
}

async function testReadOnlyPolicyBlocksWindowsPackageManagerCmdTest() {
  const violation = getToolPolicyViolation(
    "Bash",
    { command: "npm.cmd test", timeout_ms: 1000 },
    {
      allowWrite: false,
      allowNetwork: false,
      shell: "read-only"
    }
  );

  assert.match(violation ?? "", /read-only shell policy/);
}

async function testVerificationPolicyAllowsBuildTestCommands() {
  const policy = {
    allowWrite: false,
    allowNetwork: false,
    shell: "read-only" as const,
    allowBuildTest: true
  };

  for (const command of [
    "npm.cmd test",
    "npm run build",
    "pnpm lint",
    "tsc -p tsconfig.json"
  ]) {
    assert.equal(
      getToolPolicyViolation("PowerShell", { command, timeout_ms: 1000 }, policy),
      undefined
    );
  }
}

async function testVerificationPolicyStillBlocksMutatingCommands() {
  const policy = {
    allowWrite: false,
    allowNetwork: false,
    shell: "read-only" as const,
    allowBuildTest: true
  };

  for (const command of [
    "npm install",
    "npm test && Remove-Item test.txt",
    "npm test > output.txt",
    "npm test -- --output output.txt"
  ]) {
    assert.match(
      getToolPolicyViolation("PowerShell", { command, timeout_ms: 1000 }, policy) ?? "",
      /read-only shell policy|file writes are disabled|network access is disabled/
    );
  }
}

async function testReadOnlyPolicyBlocksCommandChaining() {
  for (const command of [
    "rg TODO; node script.js",
    "git status && npm test",
    "Get-ChildItem || Write-Output fallback",
    "Get-ChildItem\nGet-Content package.json"
  ]) {
    const violation = getToolPolicyViolation(
      "PowerShell",
      { command, timeout_ms: 1000 },
      {
        allowWrite: false,
        allowNetwork: false,
        shell: "read-only"
      }
    );

    assert.match(violation ?? "", /read-only shell policy/);
  }
}

async function testAnyShellPolicyBlocksWindowsPackageManagerCmdWhenWriteDisabled() {
  for (const command of [
    "npm.cmd run build",
    "pnpm.cmd test",
    "yarn.cmd run typecheck",
    "corepack pnpm test"
  ]) {
    const violation = getToolPolicyViolation(
      "PowerShell",
      { command, timeout_ms: 1000 },
      {
        allowWrite: false,
        allowNetwork: true,
        shell: "any"
      }
    );

    assert.match(violation ?? "", /file writes are disabled/);
  }
}

async function testAnyShellPolicyBlocksWindowsPackageManagerCmdInstallWhenNetworkDisabled() {
  const violation = getToolPolicyViolation(
    "PowerShell",
    { command: "corepack pnpm install", timeout_ms: 1000 },
    {
      allowWrite: true,
      allowNetwork: false,
      shell: "any"
    }
  );

  assert.match(violation ?? "", /network access is disabled/);
}

async function testAnyShellPolicyBlocksNetworkCommandWhenNetworkDisabled() {
  const result = await executeToolCall(
    "PowerShell",
    JSON.stringify({ command: "curl https://example.com", timeout_ms: 1000 }),
    createTestContext({
      toolPolicy: {
        allowWrite: true,
        allowNetwork: false,
        shell: "any"
      }
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean; error: { type: string; message: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "tool_policy_violation");
  assert.match(parsed.error.message, /network access is disabled/);
}

async function testAnyShellPolicyBlocksCommonNetworkCommands() {
  for (const command of [
    "ssh example.com",
    "gh repo view owner/repo",
    "git fetch origin"
  ]) {
    const violation = getToolPolicyViolation(
      "PowerShell",
      { command, timeout_ms: 1000 },
      {
        allowWrite: true,
        allowNetwork: false,
        shell: "any"
      }
    );

    assert.match(violation ?? "", /network access is disabled/);
  }
}

async function testPolicyBlocksSubagentOrchestrationTools() {
  const policy = {
    allowWrite: true,
    allowNetwork: true,
    shell: "any" as const
  };

  assert.equal(isToolSchemaAllowedByPolicy("AgentTool", policy), false);
  assert.equal(isToolSchemaAllowedByPolicy("TaskGet", policy), false);

  const violation = getToolPolicyViolation("TaskList", {}, policy);
  assert.match(violation ?? "", /parent orchestration tools are disabled/);
}

async function testPolicyBlocksMainSessionOnlyTools() {
  const policy = {
    allowWrite: true,
    allowNetwork: true,
    shell: "any" as const
  };

  for (const toolName of ["SkillTool", "McpStatus", "ListMcpResources", "ReadMcpResource"]) {
    assert.equal(isToolSchemaAllowedByPolicy(toolName, policy), false);
    assert.match(getToolPolicyViolation(toolName, {}, policy) ?? "", /only available in the main session/);
  }
}

async function testPolicyDoesNotHideInvalidArguments() {
  const result = await executeToolCall(
    "PowerShell",
    JSON.stringify({ command: 123 }),
    createTestContext({
      toolPolicy: {
        allowWrite: false,
        allowNetwork: false,
        shell: "read-only"
      }
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean; error: { type: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "invalid_tool_arguments");
}

async function testInvalidArgumentsDoNotRecordToolActivity() {
  const recorded: string[] = [];
  const result = await executeToolCall(
    "PowerShell",
    JSON.stringify({ command: 123 }),
    createTestContext({
      recordToolActivity: (toolName) => {
        recorded.push(toolName);
      }
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean; error: { type: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "invalid_tool_arguments");
  assert.deepEqual(recorded, []);
}

async function testRoutesMcpToolCalls() {
  const approvals: string[] = [];
  const result = await executeToolCall(
    "mcp__demo__echo",
    JSON.stringify({ text: "hello" }),
    createTestContext({
      requestApproval: async (request) => {
        approvals.push(request.kind);
        return true;
      },
      mcpRuntime: createMcpRuntime({
        getToolSchemas: async () => [],
        canExecuteTool: (toolName) => toolName === "mcp__demo__echo",
        executeToolCall: async (_toolName, args, options) => {
          const approved = await options.requestApproval({
            kind: "mcp",
            toolName: "mcp__demo__echo",
            title: "Call MCP tool",
            summary: "demo.echo",
            details: []
          });
          return {
            approved,
            args
          };
        },
        getStatus: async () => ({ servers: [] }),
        listResources: async () => ({ servers: [], resourceCount: 0 }),
        readResource: async (server, uri) => ({
          status: "not_found",
          server,
          uri,
          contents: []
        }),
        close: async () => undefined
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    result: { approved: boolean; args: { text: string } };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.approved, true);
  assert.equal(parsed.result.args.text, "hello");
  assert.deepEqual(approvals, ["mcp"]);
}

async function testRoutesCallMcpToolThroughBuiltInTool() {
  const approvals: string[] = [];
  const result = await executeToolCall(
    "CallMcpTool",
    JSON.stringify({
      server: "demo",
      tool: "echo",
      arguments: {
        text: "hello"
      }
    }),
    createTestContext({
      requestApproval: async (request) => {
        approvals.push(request.kind);
        return true;
      },
      mcpRuntime: createMcpRuntime({
        executeNamedToolCall: async (serverName, toolName, args, options) => {
          const approved = await options.requestApproval({
            kind: "mcp",
            toolName: "CallMcpTool",
            title: "Call MCP tool",
            summary: `${serverName}.${toolName}`,
            details: []
          });
          return {
            status: "completed",
            approved,
            serverName,
            toolName,
            args
          };
        }
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    result: {
      status: string;
      approved: boolean;
      serverName: string;
      toolName: string;
      args: { text: string };
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.status, "completed");
  assert.equal(parsed.result.approved, true);
  assert.equal(parsed.result.serverName, "demo");
  assert.equal(parsed.result.toolName, "echo");
  assert.equal(parsed.result.args.text, "hello");
  assert.deepEqual(approvals, ["mcp"]);
}

async function testInvalidMcpJsonDoesNotRequestApproval() {
  let approvalCount = 0;
  const result = await executeToolCall(
    "mcp__demo__echo",
    "{",
    createTestContext({
      requestApproval: async () => {
        approvalCount += 1;
        return true;
      },
      mcpRuntime: createMcpRuntime({
        getToolSchemas: async () => [],
        canExecuteTool: (toolName) => toolName === "mcp__demo__echo",
        executeToolCall: async () => {
          throw new Error("should not execute");
        },
        getStatus: async () => ({ servers: [] }),
        listResources: async () => ({ servers: [], resourceCount: 0 }),
        readResource: async (server, uri) => ({
          status: "not_found",
          server,
          uri,
          contents: []
        }),
        close: async () => undefined
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean; error: { type: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "invalid_json_arguments");
  assert.equal(approvalCount, 0);
}

async function testNonObjectMcpArgumentsDoNotExecute() {
  let executed = false;
  const result = await executeToolCall(
    "mcp__demo__echo",
    "[]",
    createTestContext({
      mcpRuntime: createMcpRuntime({
        canExecuteTool: (toolName) => toolName === "mcp__demo__echo",
        executeToolCall: async () => {
          executed = true;
          return { status: "completed" };
        }
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean; error: { type: string } };
  assert.equal(executed, false);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "invalid_tool_arguments");
}

async function testRejectedMcpResourceListUsesRejectedStatus() {
  const result = await executeToolCall(
    "ListMcpResources",
    JSON.stringify({}),
    createTestContext({
      requestApproval: async () => false,
      mcpRuntime: createMcpRuntime({})
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "rejected");
  assert.equal(parsed.error.type, "permission_rejected");
  assert.match(parsed.error.message, /User rejected the MCP resources list request/);
}

async function testRejectedMcpToolListUsesRejectedStatus() {
  const result = await executeToolCall(
    "ListMcpTools",
    JSON.stringify({}),
    createTestContext({
      requestApproval: async () => false,
      mcpRuntime: createMcpRuntime({})
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "rejected");
  assert.equal(parsed.error.type, "permission_rejected");
  assert.match(parsed.error.message, /User rejected the MCP tools list request/);
}

async function testMcpToolRecordsActivityAfterExecution() {
  const recorded: string[] = [];
  const result = await executeToolCall(
    "mcp__demo__mutate",
    JSON.stringify({ text: "hello" }),
    createTestContext({
      recordToolActivity: (toolName) => {
        recorded.push(toolName);
      },
      mcpRuntime: createMcpRuntime({
        executeToolCall: async () => ({
          status: "completed"
        })
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "success");
  assert.deepEqual(recorded, ["mcp__demo__mutate"]);
}

async function testRejectedMcpToolDoesNotRecordActivity() {
  const recorded: string[] = [];
  const result = await executeToolCall(
    "mcp__demo__mutate",
    JSON.stringify({ text: "hello" }),
    createTestContext({
      recordToolActivity: (toolName) => {
        recorded.push(toolName);
      },
      mcpRuntime: createMcpRuntime({
        executeToolCall: async () => ({
          status: "rejected"
        })
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "rejected");
  assert.equal(parsed.error.type, "permission_rejected");
  assert.equal(parsed.error.status, "rejected");
  assert.deepEqual(recorded, []);
}

async function testTimedOutMcpToolDoesNotRecordActivity() {
  const recorded: string[] = [];
  const result = await executeToolCall(
    "mcp__demo__mutate",
    JSON.stringify({ text: "hello" }),
    createTestContext({
      recordToolActivity: (toolName) => {
        recorded.push(toolName);
      },
      mcpRuntime: createMcpRuntime({
        executeToolCall: async () => {
          throw new Error("MCP tool 'demo.mutate' timed out after 10 ms.");
        }
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "timeout");
  assert.equal(parsed.error.type, "mcp_tool_timeout");
  assert.equal(parsed.error.status, "timeout");
  assert.deepEqual(recorded, []);
}

async function testPolicyDeniedMcpToolReturnsDeniedStatus() {
  const result = await executeToolCall(
    "mcp__demo__mutate",
    JSON.stringify({ text: "hello" }),
    createTestContext({
      mcpRuntime: createMcpRuntime({
        executeToolCall: async () => {
          throw new Error("MCP tool 'demo.mutate' is denied by MCP approval policy.");
        }
      })
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "denied");
  assert.equal(parsed.error.type, "policy_denied");
  assert.equal(parsed.error.status, "denied");
  assert.match(parsed.error.message, /denied by MCP approval policy/);
}

async function testReadOnlyExecutionDoesNotRecordToolActivity() {
  const recorded: string[] = [];
  const result = await executeToolCall(
    "TaskList",
    JSON.stringify({}),
    createTestContext({
      listSubagentTasks: () => [],
      recordToolActivity: (toolName) => {
        recorded.push(toolName);
      }
    })
  );

  const parsed = JSON.parse(result.displayResult) as { ok: boolean };
  assert.equal(parsed.ok, true);
  assert.deepEqual(recorded, []);
}

async function testPlanModeBlocksWriteTools() {
  const result = await executeToolCall(
    "Write",
    JSON.stringify({ file_path: "example.txt", content: "mutate" }),
    createTestContext({
      planMode: true
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "denied");
  assert.equal(parsed.error.type, "plan_mode_violation");
  assert.equal(parsed.error.status, "denied");
  assert.match(parsed.error.message, /Write is blocked in Plan Mode/);
}

async function testPlanModeBlocksArbitraryMcpTools() {
  const result = await executeToolCall(
    "mcp__demo__mutate",
    JSON.stringify({ text: "hello" }),
    createTestContext({
      planMode: true,
      mcpRuntime: createMcpRuntime({})
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "denied");
  assert.equal(parsed.error.type, "plan_mode_violation");
  assert.equal(parsed.error.status, "denied");
  assert.match(parsed.error.message, /mcp__demo__mutate is blocked in Plan Mode/);
}

async function testPlanModeBlocksMutatingShellBeforeApproval() {
  await withExternalTempDirectory(async (externalDirectory) => {
    let approvalCount = 0;
    const result = await executeToolCall(
      "PowerShell",
      JSON.stringify({
        command: "Remove-Item test.txt",
        cwd: externalDirectory,
        timeout_ms: 1000
      }),
      createTestContext({
        planMode: true,
        requestApproval: async () => {
          approvalCount += 1;
          return true;
        }
      })
    );

    const parsed = JSON.parse(result.displayResult) as {
      ok: boolean;
      status: string;
      error: { type: string; status: string; message: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "denied");
    assert.equal(parsed.error.type, "plan_mode_violation");
    assert.match(parsed.error.message, /blocked by Plan Mode/);
    assert.equal(approvalCount, 0);
  });
}

async function testPlanModeForcesApprovalForReadOnlyShell() {
  let approvalCount = 0;
  const result = await executeToolCall(
    "PowerShell",
    JSON.stringify({ command: "Get-ChildItem", timeout_ms: 1000 }),
    createTestContext({
      planMode: true,
      requestApproval: async () => {
        approvalCount += 1;
        return false;
      }
    })
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    error: { type: string; status: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "rejected");
  assert.equal(parsed.error.type, "permission_rejected");
  assert.match(parsed.error.message, /User rejected PowerShell tool request/);
  assert.equal(approvalCount, 1);
}

async function testBashCwdOutsideWorkspaceRequestsExternalDirectoryApproval() {
  await withExternalTempDirectory(async (externalDirectory) => {
    const approvals: ToolApprovalRequest[] = [];
    const result = await executeToolCall(
      "Bash",
      JSON.stringify({
        command: process.platform === "win32" ? "(Get-Location).Path" : "pwd",
        cwd: externalDirectory,
        timeout_ms: 5_000
      }),
      createTestContext({
        requestApproval: async (request) => {
          approvals.push(request);
          return true;
        }
      })
    );

    const parsed = JSON.parse(result.displayResult) as {
      ok: boolean;
      result: { cwd: string; stdout: string };
    };
    assert.equal(parsed.ok, true);
    assert.equal(path.resolve(parsed.result.cwd), path.resolve(externalDirectory));
    assert.equal(path.resolve(parsed.result.stdout.trim()), path.resolve(externalDirectory));
    assert.deepEqual(approvals.map((request) => request.kind), ["external-directory", "command"]);
    assert.equal(approvals[0]?.scope?.type, "external-directory");
    assert.equal(path.resolve(approvals[0]?.scope?.directory ?? ""), path.resolve(externalDirectory));
  });
}

async function testBashCwdOutsideWorkspaceStopsWhenExternalDirectoryRejected() {
  await withExternalTempDirectory(async (externalDirectory) => {
    const approvals: ToolApprovalRequest[] = [];
    const result = await executeToolCall(
      "Bash",
      JSON.stringify({
        command: process.platform === "win32" ? "(Get-Location).Path" : "pwd",
        cwd: externalDirectory,
        timeout_ms: 5_000
      }),
      createTestContext({
        requestApproval: async (request) => {
          approvals.push(request);
          return request.kind !== "external-directory";
        }
      })
    );

    const parsed = JSON.parse(result.displayResult) as {
      ok: boolean;
      status: string;
      error: { type: string; message: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "rejected");
    assert.equal(parsed.error.type, "permission_rejected");
    assert.match(parsed.error.message, /User rejected external directory access/);
    assert.deepEqual(approvals.map((request) => request.kind), ["external-directory"]);
  });
}

async function testPowerShellCwdOutsideWorkspaceRequestsExternalDirectoryApproval() {
  if (process.platform !== "win32") {
    return;
  }

  await withExternalTempDirectory(async (externalDirectory) => {
    const approvals: ToolApprovalRequest[] = [];
    const result = await executeToolCall(
      "PowerShell",
      JSON.stringify({
        command: "(Get-Location).Path",
        cwd: externalDirectory,
        timeout_ms: 5_000
      }),
      createTestContext({
        requestApproval: async (request) => {
          approvals.push(request);
          return true;
        }
      })
    );

    const parsed = JSON.parse(result.displayResult) as {
      ok: boolean;
      result: { cwd: string; stdout: string };
    };
    assert.equal(parsed.ok, true);
    assert.equal(path.resolve(parsed.result.cwd), path.resolve(externalDirectory));
    assert.equal(path.resolve(parsed.result.stdout.trim()), path.resolve(externalDirectory));
    assert.deepEqual(approvals.map((request) => request.kind), ["external-directory", "command"]);
  });
}

async function testBashFileMutationsDoNotPopulateFileHistory() {
  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const history = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
    });
    const createdPath = path.join(workspaceRoot, "bash-created.txt");
    const deletedPath = path.join(workspaceRoot, "bash-deleted.txt");
    await fs.writeFile(deletedPath, "before\n");

    history.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "Bash",
      JSON.stringify({
        command: "node -e \"require('fs').writeFileSync('bash-created.txt', 'created\\n')\"",
        timeout_ms: 5_000
      }),
      context
    ));
    assertSuccessfulShellResult(await executeToolCall(
      "Bash",
      JSON.stringify({
        command: "node -e \"require('fs').unlinkSync('bash-deleted.txt')\"",
        timeout_ms: 5_000
      }),
      context
    ));
    await history.finalizeTurn(turnId);

    assert.equal(await fs.readFile(createdPath, "utf8"), "created\n");
    await assert.rejects(fs.stat(deletedPath), { code: "ENOENT" });
    assert.equal(history.hasTrackedFiles(turnId), false);
    assert.equal(history.canRestoreTurn(turnId), false);
    assert.equal((await history.restoreTurn(turnId)).missingSnapshot, true);
  });
}

async function testPowerShellVariableFileMutationsPopulateFileHistory() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const history = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
    });
    const createdPath = path.join(workspaceRoot, "powershell-created.txt");
    const deletedPath = path.join(workspaceRoot, "powershell-deleted.txt");
    await fs.writeFile(deletedPath, "before\n");

    history.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "PowerShell",
      JSON.stringify({
        command: "$target = 'powershell-created.txt'; Set-Content -LiteralPath $target -Value 'created'",
        timeout_ms: 5_000
      }),
      context
    ));
    assertSuccessfulShellResult(await executeToolCall(
      "PowerShell",
      JSON.stringify({
        command: "$target = 'powershell-deleted.txt'; Remove-Item -LiteralPath $target",
        timeout_ms: 5_000
      }),
      context
    ));
    await history.finalizeTurn(turnId);

    assert.equal((await fs.readFile(createdPath, "utf8")).trim(), "created");
    await assert.rejects(fs.stat(deletedPath), { code: "ENOENT" });
    assert.equal(history.hasTrackedFiles(turnId), true);
    assert.equal(history.canRestoreTurn(turnId), true);

    const result = await history.restoreTurn(turnId);
    assert.deepEqual(result.restored, [deletedPath]);
    assert.deepEqual(result.removed, [createdPath]);
    assert.equal(await fs.readFile(deletedPath, "utf8"), "before\n");
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
  });
}

async function testBashDirectoryMutationDoesNotPopulateFileHistoryAsFile() {
  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const history = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
    });
    const createdDirectory = path.join(workspaceRoot, "bash-created-dir");

    history.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "Bash",
      JSON.stringify({
        command: "mkdir bash-created-dir",
        timeout_ms: 5_000
      }),
      context
    ));
    await history.finalizeTurn(turnId);

    assert.equal((await fs.stat(createdDirectory)).isDirectory(), true);
    assert.equal(history.hasTrackedFiles(turnId), true);
    assert.equal(history.canRestoreTurn(turnId), true);
    const result = await history.restoreTurn(turnId);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, [createdDirectory]);
    await assert.rejects(fs.stat(createdDirectory), { code: "ENOENT" });
  });
}

async function testPowerShellDirectoryMutationDoesNotPopulateFileHistoryAsFile() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const history = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
    });
    const createdDirectory = path.join(workspaceRoot, "powershell-created-dir");

    history.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "PowerShell",
      JSON.stringify({
        command: "New-Item -Path 'powershell-created-dir' -ItemType Directory",
        timeout_ms: 5_000
      }),
      context
    ));
    await history.finalizeTurn(turnId);

    assert.equal((await fs.stat(createdDirectory)).isDirectory(), true);
    assert.equal(history.hasTrackedFiles(turnId), true);
    assert.equal(history.canRestoreTurn(turnId), true);
    const result = await history.restoreTurn(turnId);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, [createdDirectory]);
    await assert.rejects(fs.stat(createdDirectory), { code: "ENOENT" });
  });
}

async function testBashRedirectionCapturesIgnoredPathInFileHistory() {
  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const history = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
    });
    const ignoredPath = path.join(workspaceRoot, "ignored.log");
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "ignored.log\n");

    history.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "Bash",
      JSON.stringify({
        command: "echo created > ignored.log",
        timeout_ms: 5_000
      }),
      context
    ));
    await history.finalizeTurn(turnId);

    assert.equal(history.hasTrackedFiles(turnId), true);
    assert.equal(history.canRestoreTurn(turnId), true);
    const result = await history.restoreTurn(turnId);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, [ignoredPath]);
    await assert.rejects(fs.stat(ignoredPath), { code: "ENOENT" });
  });
}

async function testBashOnWindowsPowerShellCommandCapturesExplicitPath() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const history = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
    });
    const createdPath = path.join(workspaceRoot, "bash-powershell-created.log");
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "*.log\n");

    history.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "Bash",
      JSON.stringify({
        command: "Set-Content -LiteralPath 'bash-powershell-created.log' -Value 'created'",
        timeout_ms: 5_000
      }),
      context
    ));
    await history.finalizeTurn(turnId);

    assert.equal(history.hasTrackedFiles(turnId), true);
    assert.equal(history.canRestoreTurn(turnId), true);
    assert.equal((await fs.readFile(createdPath, "utf8")).trim(), "created");

    const result = await history.restoreTurn(turnId);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, [createdPath]);
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
  });
}

async function testPowerShellExplicitPathMutationsPopulateFileHistory() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const history = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
    });
    const createdPath = path.join(workspaceRoot, "powershell-explicit-created.log");
    const deletedPath = path.join(workspaceRoot, "powershell-explicit-deleted.log");
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "*.log\n");
    await fs.writeFile(deletedPath, "before\n");

    history.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "PowerShell",
      JSON.stringify({
        command: [
          "New-Item -Path 'powershell-explicit-created.log' -ItemType File",
          "Remove-Item -LiteralPath 'powershell-explicit-deleted.log'"
        ].join("; "),
        timeout_ms: 5_000
      }),
      context
    ));
    await history.finalizeTurn(turnId);

    assert.equal(history.hasTrackedFiles(turnId), true);
    assert.equal(history.canRestoreTurn(turnId), true);
    const result = await history.restoreTurn(turnId);
    assert.deepEqual(result.restored, [deletedPath]);
    assert.deepEqual(result.removed, [createdPath]);
    assert.equal(await fs.readFile(deletedPath, "utf8"), "before\n");
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
  });
}

async function testPowerShellExternalStaticPathMutationPopulatesFileHistory() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    await withExternalTempDirectory(async (externalDirectory) => {
      const turnId = "test-turn";
      const history = new FileHistoryManager();
      const context = createTestContext({
        workspaceRoot,
        allowedRoots: [workspaceRoot],
        turnId,
        captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
      });
      const deletedPath = path.join(externalDirectory, "external-deleted.txt");
      await fs.writeFile(deletedPath, "before\n");

      history.beginTurn(turnId);
      assertSuccessfulShellResult(await executeToolCall(
        "PowerShell",
        JSON.stringify({
          command: `Remove-Item -Path "${deletedPath}"`,
          timeout_ms: 5_000
        }),
        context
      ));
      await history.finalizeTurn(turnId);

      assert.equal(history.hasTrackedFiles(turnId), true);
      assert.equal(history.canRestoreTurn(turnId), true);
      await assert.rejects(fs.stat(deletedPath), { code: "ENOENT" });

      const result = await history.restoreTurn(turnId);
      assert.deepEqual(result.restored, [deletedPath]);
      assert.deepEqual(result.removed, []);
      assert.equal(await fs.readFile(deletedPath, "utf8"), "before\n");
    });
  });
}

async function testPowerShellExternalHomeEnvMutationPopulatesFileHistory() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    await withExternalTempDirectory(async (externalDirectory) => {
      const originalUserProfile = process.env.USERPROFILE;
      process.env.USERPROFILE = externalDirectory;
      try {
        const turnId = "test-turn";
        const history = new FileHistoryManager();
        const context = createTestContext({
          workspaceRoot,
          allowedRoots: [workspaceRoot],
          turnId,
          captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
        });
        const createdDirectory = path.join(externalDirectory, "alyce-env-capture");

        history.beginTurn(turnId);
        assertSuccessfulShellResult(await executeToolCall(
          "PowerShell",
          JSON.stringify({
            command: [
              'New-Item -ItemType Directory -Path "$env:USERPROFILE\\alyce-env-capture"',
              'Set-Content -Path "$env:USERPROFILE\\alyce-env-capture\\note.txt" -Value "created"',
              'Remove-Item -Path "$env:USERPROFILE\\alyce-env-capture\\note.txt"'
            ].join("; "),
            timeout_ms: 15_000
          }),
          context
        ));
        await history.finalizeTurn(turnId);

        assert.equal(history.hasTrackedFiles(turnId), true);
        assert.equal(history.canRestoreTurn(turnId), true);
        assert.equal((await fs.stat(createdDirectory)).isDirectory(), true);

        const result = await history.restoreTurn(turnId);
        assert.deepEqual(result.restored, []);
        assert.deepEqual(result.removed, [createdDirectory]);
        await assert.rejects(fs.stat(createdDirectory), { code: "ENOENT" });
      } finally {
        if (originalUserProfile === undefined) {
          delete process.env.USERPROFILE;
        } else {
          process.env.USERPROFILE = originalUserProfile;
        }
      }
    });
  });
}

async function testPowerShellExternalVariableDesktopMutationPopulatesFileHistory() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    await withExternalTempDirectory(async (externalDirectory) => {
      const originalUserProfile = process.env.USERPROFILE;
      process.env.USERPROFILE = externalDirectory;
      try {
        const desktopDirectory = path.join(externalDirectory, "Desktop");
        await fs.mkdir(desktopDirectory, { recursive: true });
        const turnId = "test-turn";
        const history = new FileHistoryManager();
        const context = createTestContext({
          workspaceRoot,
          allowedRoots: [workspaceRoot],
          turnId,
          captureFileBeforeWrite: (absolutePath) => history.captureBeforeWrite(turnId, absolutePath)
        });
        const createdDirectory = path.join(desktopDirectory, "新文件夹");

        history.beginTurn(turnId);
        assertSuccessfulShellResult(await executeToolCall(
          "PowerShell",
          JSON.stringify({
            command: [
              '$desktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")',
              'if (-not (Test-Path $desktopPath)) {',
              '    # localized fallback',
              '    $desktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "OneDrive", "桌面")',
              '    if (-not (Test-Path $desktopPath)) {',
              '        $desktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "OneDrive", "Desktop")',
              '    }',
              '}',
              '$newFolderPath = [System.IO.Path]::Combine($desktopPath, "新文件夹")',
              'New-Item -Path $newFolderPath -ItemType Directory -Force',
              'Write-Output "文件夹已创建在: $newFolderPath"'
            ].join("\n"),
            timeout_ms: 15_000
          }),
          context
        ));
        await history.finalizeTurn(turnId);

        assert.equal(history.hasTrackedFiles(turnId), true);
        assert.equal(history.canRestoreTurn(turnId), true);
        assert.equal((await fs.stat(createdDirectory)).isDirectory(), true);

        const result = await history.restoreTurn(turnId);
        assert.deepEqual(result.restored, []);
        assert.deepEqual(result.removed, [createdDirectory]);
        await assert.rejects(fs.stat(createdDirectory), { code: "ENOENT" });
      } finally {
        if (originalUserProfile === undefined) {
          delete process.env.USERPROFILE;
        } else {
          process.env.USERPROFILE = originalUserProfile;
        }
      }
    });
  });
}

async function testBashFileMutationsAreCapturedByTurnSnapshot() {
  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const snapshots = new TurnSnapshotService({
      workspaceRoot,
      snapshotRoot: path.join(workspaceRoot, ".alyce", "snapshots", "git")
    });
    const fileHistory = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => fileHistory.captureBeforeWrite(turnId, absolutePath)
    });
    const createdPath = path.join(workspaceRoot, "bash-snapshot-created.txt");
    const deletedPath = path.join(workspaceRoot, "bash-snapshot-deleted.txt");
    await fs.writeFile(deletedPath, "before\n");

    fileHistory.beginTurn(turnId);
    await snapshots.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "Bash",
      JSON.stringify({
        command: "node -e \"require('fs').writeFileSync('bash-snapshot-created.txt', 'created\\n'); require('fs').unlinkSync('bash-snapshot-deleted.txt')\"",
        timeout_ms: 5_000
      }),
      context
    ));
    await snapshots.finalizeTurn(turnId);

    const report = await new DiffService({
      workspaceRoot,
      fileHistoryManager: fileHistory,
      turnSnapshotService: snapshots
    }).getTurnDiff(turnId);
    assert.deepEqual(
      report.files.map((file) => [file.path, file.status]),
      [
        ["bash-snapshot-created.txt", "added"],
        ["bash-snapshot-deleted.txt", "deleted"]
      ]
    );

    const result = await snapshots.restoreTurn(turnId);
    assert.deepEqual(result.restored, [deletedPath]);
    assert.deepEqual(result.removed, [createdPath]);
    assert.equal(await fs.readFile(deletedPath, "utf8"), "before\n");
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
  });
}

async function testPowerShellFileMutationsAreCapturedByTurnSnapshot() {
  if (process.platform !== "win32") {
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    const turnId = "test-turn";
    const snapshots = new TurnSnapshotService({
      workspaceRoot,
      snapshotRoot: path.join(workspaceRoot, ".alyce", "snapshots", "git")
    });
    const fileHistory = new FileHistoryManager();
    const context = createTestContext({
      workspaceRoot,
      allowedRoots: [workspaceRoot],
      turnId,
      captureFileBeforeWrite: (absolutePath) => fileHistory.captureBeforeWrite(turnId, absolutePath)
    });
    const createdPath = path.join(workspaceRoot, "powershell-snapshot-created.txt");
    const deletedPath = path.join(workspaceRoot, "powershell-snapshot-deleted.txt");
    await fs.writeFile(deletedPath, "before\n");

    fileHistory.beginTurn(turnId);
    await snapshots.beginTurn(turnId);
    assertSuccessfulShellResult(await executeToolCall(
      "PowerShell",
      JSON.stringify({
        command: [
          "Set-Content -LiteralPath 'powershell-snapshot-created.txt' -Value 'created'",
          "Remove-Item -LiteralPath 'powershell-snapshot-deleted.txt'"
        ].join("; "),
        timeout_ms: 5_000
      }),
      context
    ));
    await snapshots.finalizeTurn(turnId);

    const report = await new DiffService({
      workspaceRoot,
      fileHistoryManager: fileHistory,
      turnSnapshotService: snapshots
    }).getTurnDiff(turnId);
    assert.deepEqual(
      report.files.map((file) => [file.path, file.status]),
      [
        ["powershell-snapshot-created.txt", "added"],
        ["powershell-snapshot-deleted.txt", "deleted"]
      ]
    );

    const result = await snapshots.restoreTurn(turnId);
    assert.deepEqual(result.restored, [deletedPath]);
    assert.deepEqual(result.removed, [createdPath]);
    assert.equal(await fs.readFile(deletedPath, "utf8"), "before\n");
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
  });
}

async function testPowerShellTimeoutReturnsStructuredTimeout() {
  if (process.platform !== "win32") {
    return;
  }

  const result = await executeToolCall(
    "PowerShell",
    JSON.stringify({ command: "Start-Sleep -Seconds 5", timeout_ms: 50 }),
    createTestContext()
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    result: { timedOut: boolean };
    error: { type: string; status: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "timeout");
  assert.equal(parsed.error.type, "tool_timeout");
  assert.equal(parsed.result.timedOut, true);
}

async function testBashTimeoutReturnsStructuredTimeout() {
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
  const result = await executeToolCall(
    "Bash",
    JSON.stringify({ command, timeout_ms: 50 }),
    createTestContext()
  );

  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    status: string;
    result: { timedOut: boolean };
    error: { type: string; status: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "timeout");
  assert.equal(parsed.error.type, "tool_timeout");
  assert.equal(parsed.result.timedOut, true);
}

async function withExternalTempDirectory(callback: (directory: string) => Promise<void>) {
  const externalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-external-cwd-"));
  try {
    await callback(externalDirectory);
  } finally {
    await fs.rm(externalDirectory, { recursive: true, force: true });
  }
}

async function withTempWorkspace(callback: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-shell-history-"));
  try {
    await callback(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

function assertSuccessfulShellResult(result: { displayResult: string }) {
  const parsed = JSON.parse(result.displayResult) as {
    ok: boolean;
    result: {
      exitCode: number | null;
      timedOut: boolean;
      stderr: string;
    };
  };

  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.exitCode, 0);
  assert.equal(parsed.result.timedOut, false);
}

function createMcpRuntime(patch: Partial<ToolExecutionContext["mcpRuntime"]>) {
  return {
    getToolSchemas: async () => [],
    canExecuteTool: (toolName: string) => toolName === "mcp__demo__mutate",
    executeNamedToolCall: async () => undefined,
    executeToolCall: async () => undefined,
    getStatus: async () => ({ servers: [] }),
    listTools: async () => ({ servers: [], toolCount: 0 }),
    listResources: async () => ({ servers: [], resourceCount: 0 }),
    listPrompts: async () => ({ servers: [], promptCount: 0 }),
    getPrompt: async (serverName: string, promptName: string) => ({
      status: "not_found" as const,
      server: serverName,
      name: promptName,
      messages: [],
      error: "not found"
    }),
    listResourceTemplates: async () => ({ servers: [], resourceTemplateCount: 0 }),
    readResource: async (server: string, uri: string) => ({
      status: "not_found" as const,
      server,
      uri,
      contents: []
    }),
    reloadConfig: async () => undefined,
    addServer: async (
      name: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["addServer"]>[0],
      _config: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["addServer"]>[1],
      options: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["addServer"]>[2] = {}
    ) => ({
      changed: true,
      scope: options.scope ?? "project",
      serverName: name,
      configPath: "C:\\workspace\\.alyce\\mcp.json",
      state: {
        paths: {
          project: "C:\\workspace\\.alyce\\mcp.json",
          local: "C:\\workspace\\.alyce\\mcp.local.json",
          user: "C:\\Users\\Single\\.alyce\\mcp.json"
        },
        configs: {
          project: { mcpServers: {} },
          local: { mcpServers: {} },
          user: { mcpServers: {} }
        },
        effective: { mcpServers: {} },
        sources: {}
      }
    }),
    removeServer: async (
      name: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["removeServer"]>[0],
      options: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["removeServer"]>[1] = {}
    ) => ({
      changed: true,
      scope: options.scope ?? "project",
      serverName: name,
      configPath: "C:\\workspace\\.alyce\\mcp.json",
      state: {
        paths: {
          project: "C:\\workspace\\.alyce\\mcp.json",
          local: "C:\\workspace\\.alyce\\mcp.local.json",
          user: "C:\\Users\\Single\\.alyce\\mcp.json"
        },
        configs: {
          project: { mcpServers: {} },
          local: { mcpServers: {} },
          user: { mcpServers: {} }
        },
        effective: { mcpServers: {} },
        sources: {}
      }
    }),
    setServerEnabled: async (
      name: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["setServerEnabled"]>[0],
      _enabled: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["setServerEnabled"]>[1],
      options: Parameters<NonNullable<ToolExecutionContext["mcpRuntime"]>["setServerEnabled"]>[2] = {}
    ) => ({
      changed: true,
      scope: options.scope ?? "project",
      serverName: name,
      configPath: "C:\\workspace\\.alyce\\mcp.json",
      state: {
        paths: {
          project: "C:\\workspace\\.alyce\\mcp.json",
          local: "C:\\workspace\\.alyce\\mcp.local.json",
          user: "C:\\Users\\Single\\.alyce\\mcp.json"
        },
        configs: {
          project: { mcpServers: {} },
          local: { mcpServers: {} },
          user: { mcpServers: {} }
        },
        effective: { mcpServers: {} },
        sources: {}
      }
    }),
    loginServer: async (serverName: string) => ({
      status: "completed" as const,
      server: serverName,
      message: "Logged in."
    }),
    setInteractionHandlers: () => undefined,
    close: async () => undefined,
    ...patch
  };
}

void runTests();
