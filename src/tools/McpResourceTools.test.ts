import assert from "node:assert/strict";
import {
  executeCallMcpToolTool
} from "./CallMcpToolTool/CallMcpToolTool.js";
import {
  executeListMcpToolsTool
} from "./ListMcpToolsTool/ListMcpToolsTool.js";
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
  await testListToolsRequiresApproval();
  await testListToolsFiltersResults();
  await testCallToolPassesServerToolAndArguments();
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
    mcpRuntime: createMcpRuntime({
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
    })
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

async function testListToolsRequiresApproval() {
  const approvals: string[] = [];
  const result = await executeListMcpToolsTool({ server: "mock" }, createTestContext({
    requestApproval: async (request) => {
      approvals.push(request.kind);
      return true;
    },
    mcpRuntime: createMcpRuntime({
      listTools: async (options) => ({
        servers: [{
          server: options?.serverName ?? "",
          status: "completed",
          tools: []
        }],
        toolCount: 0
      })
    })
  }));

  assert.deepEqual(approvals, ["mcp"]);
  assert.equal(result.servers[0]?.server, "mock");
}

async function testListToolsFiltersResults() {
  const recorded: string[] = [];
  const result = await executeListMcpToolsTool({
    query: "deploy",
    limit: 1
  }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    mcpRuntime: createMcpRuntime({
      listTools: async () => ({
        servers: [{
          server: "mock",
          status: "completed",
          tools: [
            {
              server: "mock",
              name: "echo",
              exposedName: "mcp__mock__echo",
              description: "Echo text."
            },
            {
              server: "mock",
              name: "collect_deploy_info",
              exposedName: "mcp__mock__collect_deploy_info",
              description: "Collect deploy settings."
            }
          ]
        }],
        toolCount: 2
      })
    })
  }));

  assert.equal(result.toolCount, 1);
  assert.deepEqual(result.servers[0]?.tools.map((tool) => tool.name), ["collect_deploy_info"]);
  assert.deepEqual(recorded, ["ListMcpTools"]);
}

async function testCallToolPassesServerToolAndArguments() {
  const recorded: string[] = [];
  const result = await executeCallMcpToolTool({
    server: "mock",
    tool: "echo",
    arguments: {
      text: "hello"
    }
  }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    mcpRuntime: createMcpRuntime({
      executeNamedToolCall: async (serverName, toolName, args) => ({
        status: "completed",
        serverName,
        toolName,
        args
      })
    })
  })) as {
    status: string;
    serverName: string;
    toolName: string;
    args: { text: string };
  };

  assert.equal(result.status, "completed");
  assert.equal(result.serverName, "mock");
  assert.equal(result.toolName, "echo");
  assert.equal(result.args.text, "hello");
  assert.deepEqual(recorded, ["CallMcpTool"]);
}

async function testListResourcesRequiresApproval() {
  const approvals: string[] = [];
  const result = await executeListMcpResourcesTool({ server: "mock" }, createTestContext({
    requestApproval: async (request) => {
      approvals.push(request.kind);
      return true;
    },
    mcpRuntime: createMcpRuntime({
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
    })
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
    mcpRuntime: createMcpRuntime({
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
    })
  }));

  assert.deepEqual(recorded, ["ListMcpResources"]);
}

async function testReadResourcePassesServerUriAndLimit() {
  const result = await executeReadMcpResourceTool({
    server: "mock",
    uri: "mock://text",
    max_chars: 100
  }, createTestContext({
    mcpRuntime: createMcpRuntime({
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
    })
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
    mcpRuntime: createMcpRuntime({
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
    })
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
    mcpRuntime: createMcpRuntime({
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
    })
  }));

  assert.equal(called, false);
  assert.equal(result.status, "error");
}

function createMcpRuntime(patch: Partial<ToolExecutionContext["mcpRuntime"]> = {}) {
  return {
    getToolSchemas: async () => [],
    canExecuteTool: () => false,
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
