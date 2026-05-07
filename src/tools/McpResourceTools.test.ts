import assert from "node:assert/strict";
import {
  executeListMcpResourcesTool
} from "./ListMcpResourcesTool/ListMcpResourcesTool.js";
import {
  executeMcpStatusTool
} from "./McpStatusTool/McpStatusTool.js";
import {
  executeReadMcpResourceTool
} from "./ReadMcpResourceTool/ReadMcpResourceTool.js";
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
  await testStatusSnapshotCallsRuntimeWithoutApproval();
  await testStatusInitializesRuntimeByDefault();
  await testStatusCanSkipInitialization();
  await testRejectedStatusInitializationDoesNotCallRuntime();
  await testListResourcesRequiresApproval();
  await testListResourcesRecordsToolActivity();
  await testReadResourcePassesServerUriAndLimit();
  await testCompletedReadResourceRecordsToolActivity();
  await testRejectedReadDoesNotCallRuntime();
  console.log("MCP resource tool tests passed");
}

async function testStatusSnapshotCallsRuntimeWithoutApproval() {
  let approvalCount = 0;
  const result = await executeMcpStatusTool({ initialize: false }, createTestContext({
    requestApproval: async () => {
      approvalCount += 1;
      return true;
    },
    mcpRuntime: {
      getToolSchemas: async () => [],
      canExecuteTool: () => false,
      executeToolCall: async () => undefined,
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
  }));

  assert.deepEqual(result, { servers: [] });
  assert.equal(approvalCount, 0);
}

async function testStatusInitializesRuntimeByDefault() {
  const initializeValues: Array<boolean | undefined> = [];
  const approvals: string[] = [];
  const recorded: string[] = [];
  await executeMcpStatusTool({}, createTestContext({
    requestApproval: async (request) => {
      approvals.push(request.kind);
      return true;
    },
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    mcpRuntime: createMcpRuntime({
      getStatus: async (options) => {
        initializeValues.push(options?.initialize);
        return { servers: [] };
      }
    })
  }));

  assert.deepEqual(approvals, ["mcp"]);
  assert.deepEqual(initializeValues, [true]);
  assert.deepEqual(recorded, ["McpStatus"]);
}

async function testStatusCanSkipInitialization() {
  const initializeValues: Array<boolean | undefined> = [];
  await executeMcpStatusTool({ initialize: false }, createTestContext({
    mcpRuntime: createMcpRuntime({
      getStatus: async (options) => {
        initializeValues.push(options?.initialize);
        return { servers: [] };
      }
    })
  }));

  assert.deepEqual(initializeValues, [false]);
}

async function testRejectedStatusInitializationDoesNotCallRuntime() {
  let called = false;
  const result = await executeMcpStatusTool({}, createTestContext({
    requestApproval: async () => false,
    mcpRuntime: createMcpRuntime({
      getStatus: async () => {
        called = true;
        return { servers: [] };
      }
    })
  }));

  assert.equal(called, false);
  assert.deepEqual(result, {
    servers: [],
    message: "User rejected MCP initialization."
  });
}

async function testListResourcesRequiresApproval() {
  const approvals: string[] = [];
  const result = await executeListMcpResourcesTool({ server: "mock" }, createTestContext({
    requestApproval: async (request) => {
      approvals.push(request.kind);
      return true;
    },
    mcpRuntime: {
      getToolSchemas: async () => [],
      canExecuteTool: () => false,
      executeToolCall: async () => undefined,
      getStatus: async () => ({ servers: [] }),
      listResources: async (options) => ({
        servers: [{
          server: options?.serverName ?? "",
          status: "completed",
          resources: []
        }],
        resourceCount: 0
      }),
      readResource: async (server, uri) => ({
        status: "not_found",
        server,
        uri,
        contents: []
      }),
      close: async () => undefined
    }
  }));

  assert.deepEqual(approvals, ["mcp"]);
  assert.equal(result.servers[0]?.server, "mock");
}

async function testListResourcesRecordsToolActivity() {
  const recorded: string[] = [];
  await executeListMcpResourcesTool({ server: "mock" }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    mcpRuntime: {
      getToolSchemas: async () => [],
      canExecuteTool: () => false,
      executeToolCall: async () => undefined,
      getStatus: async () => ({ servers: [] }),
      listResources: async () => ({
        servers: [{
          server: "mock",
          status: "completed",
          resources: []
        }],
        resourceCount: 0
      }),
      readResource: async (server, uri) => ({
        status: "not_found",
        server,
        uri,
        contents: []
      }),
      close: async () => undefined
    }
  }));

  assert.deepEqual(recorded, ["ListMcpResources"]);
}

async function testReadResourcePassesServerUriAndLimit() {
  const result = await executeReadMcpResourceTool({
    server: "mock",
    uri: "mock://text",
    max_chars: 100
  }, createTestContext({
    mcpRuntime: {
      getToolSchemas: async () => [],
      canExecuteTool: () => false,
      executeToolCall: async () => undefined,
      getStatus: async () => ({ servers: [] }),
      listResources: async () => ({ servers: [], resourceCount: 0 }),
      readResource: async (server, uri, options) => ({
        status: "completed",
        server,
        uri,
        contents: [{
          type: "text",
          uri,
          text: String(options?.maxTextChars),
          length: 3,
          truncated: false
        }]
      }),
      close: async () => undefined
    }
  }));

  assert.equal(result.server, "mock");
  assert.equal(result.uri, "mock://text");
  assert.equal(result.contents[0]?.type === "text" ? result.contents[0].text : "", "100");
}

async function testCompletedReadResourceRecordsToolActivity() {
  const recorded: string[] = [];
  const result = await executeReadMcpResourceTool({
    server: "mock",
    uri: "mock://text"
  }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    mcpRuntime: {
      getToolSchemas: async () => [],
      canExecuteTool: () => false,
      executeToolCall: async () => undefined,
      getStatus: async () => ({ servers: [] }),
      listResources: async () => ({ servers: [], resourceCount: 0 }),
      readResource: async (server, uri) => ({
        status: "completed",
        server,
        uri,
        contents: [{
          type: "text",
          uri,
          text: "hello",
          length: 5,
          truncated: false
        }]
      }),
      close: async () => undefined
    }
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(recorded, ["ReadMcpResource"]);
}

async function testRejectedReadDoesNotCallRuntime() {
  let called = false;
  const result = await executeReadMcpResourceTool({
    server: "mock",
    uri: "mock://text"
  }, createTestContext({
    requestApproval: async () => false,
    mcpRuntime: {
      getToolSchemas: async () => [],
      canExecuteTool: () => false,
      executeToolCall: async () => undefined,
      getStatus: async () => ({ servers: [] }),
      listResources: async () => ({ servers: [], resourceCount: 0 }),
      readResource: async (server, uri) => {
        called = true;
        return {
          status: "completed",
          server,
          uri,
          contents: []
        };
      },
      close: async () => undefined
    }
  }));

  assert.equal(called, false);
  assert.equal(result.status, "error");
}

function createMcpRuntime(patch: Partial<ToolExecutionContext["mcpRuntime"]> = {}) {
  return {
    getToolSchemas: async () => [],
    canExecuteTool: () => false,
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
