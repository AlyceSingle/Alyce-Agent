import assert from "node:assert/strict";
import { executeToolCall } from "./executeToolCall.js";
import { getToolPolicyViolation, isToolSchemaAllowedByPolicy } from "./toolPolicy.js";
import type { ToolExecutionContext } from "./types.js";

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
  await testReadOnlyPolicyBlocksCommandChaining();
  await testAnyShellPolicyBlocksNetworkCommandWhenNetworkDisabled();
  await testAnyShellPolicyBlocksCommonNetworkCommands();
  await testPolicyBlocksSubagentOrchestrationTools();
  await testPolicyBlocksMainSessionOnlyTools();
  await testPolicyDoesNotHideInvalidArguments();
  await testRoutesMcpToolCalls();
  await testInvalidMcpJsonDoesNotRequestApproval();
  await testNonObjectMcpArgumentsDoNotExecute();
  await testMcpToolRecordsActivityAfterExecution();
  await testRejectedMcpToolDoesNotRecordActivity();
  await testInvalidArgumentsDoNotRecordToolActivity();
  await testReadOnlyExecutionDoesNotRecordToolActivity();
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
      mcpRuntime: {
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
      }
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
      mcpRuntime: {
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
      }
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

  const parsed = JSON.parse(result.displayResult) as { ok: boolean };
  assert.equal(parsed.ok, true);
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

  const parsed = JSON.parse(result.displayResult) as { ok: boolean };
  assert.equal(parsed.ok, true);
  assert.deepEqual(recorded, []);
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

function createMcpRuntime(patch: Partial<ToolExecutionContext["mcpRuntime"]>) {
  return {
    getToolSchemas: async () => [],
    canExecuteTool: (toolName: string) => toolName === "mcp__demo__mutate",
    executeToolCall: async () => undefined,
    getStatus: async () => ({ servers: [] }),
    listResources: async () => ({ servers: [], resourceCount: 0 }),
    readResource: async (server: string, uri: string) => ({
      status: "not_found" as const,
      server,
      uri,
      contents: []
    }),
    close: async () => undefined,
    ...patch
  };
}

void runTests();
