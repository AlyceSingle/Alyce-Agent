import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFunctionToolName } from "../core/api/openaiFunctionTools.js";
import { loadProjectMcpConfig } from "./config.js";
import { createProjectMcpRuntime } from "./runtime.js";
import { decodeMcpToolName, encodeMcpToolName } from "./toolNames.js";

type McpFixtureName = "mockMcpServer" | "hangingToolsMcpServer";

async function runTests() {
  await testLoadsProjectMcpConfig();
  await testLoadsRemoteMcpConfig();
  await testRuntimeSurvivesInvalidMcpConfig();
  testEncodesAndDecodesToolNames();
  testTruncatesToolNamesWithoutLosingShape();
  await testRuntimeUsesStdioServerTools();
  await testRuntimeStatusDoesNotInitializeServersByDefault();
  await testRuntimeToolSchemasDoNotInitializeServersByDefault();
  await testRuntimeClearsToolIndexOnClose();
  await testRuntimeTimesOutHangingToolDiscovery();
  await testRuntimeCloseClearsInitializingState();
  await testRuntimeCanAbortToolDiscovery();
  await testRuntimeCanRetryAfterAbortedToolDiscovery();
  await testRuntimeListsAndReadsResources();
  console.log("MCP tests passed");
}

async function testLoadsProjectMcpConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-config-"));
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "Chrome DevTools": {
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest"],
          cwd: ".",
          startup_timeout_ms: 10_000
        }
      }
    }),
    "utf8"
  );

  const config = await loadProjectMcpConfig(root);
  assert.deepEqual(Object.keys(config.mcpServers), ["chrome-devtools"]);
  const chrome = config.mcpServers["chrome-devtools"];
  assert.equal(chrome?.type, "stdio");
  assert.equal(chrome?.type === "stdio" ? chrome.command : undefined, "npx");
  assert.equal(chrome?.type === "stdio" ? chrome.cwd : undefined, root);
}

async function testLoadsRemoteMcpConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-remote-config-"));
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: {
            "x-test": "1"
          }
        }
      }
    }),
    "utf8"
  );

  const config = await loadProjectMcpConfig(root);
  const remote = config.mcpServers.remote;
  assert.equal(remote?.type, "streamable_http");
  assert.equal(remote?.type === "streamable_http" ? remote.url : undefined, "https://example.com/mcp");
}

async function testRuntimeSurvivesInvalidMcpConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-invalid-runtime-"));
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(path.join(root, ".alyce", "mcp.json"), "{", "utf8");

  const runtime = await createProjectMcpRuntime(root);
  try {
    const schemas = await runtime.getToolSchemas({ initialize: true });
    assert.deepEqual(schemas, []);

    const status = await runtime.getStatus();
    assert.equal(status.servers[0]?.name, "configuration");
    assert.equal(status.servers[0]?.status, "error");
    assert.match(status.servers[0]?.error ?? "", /Invalid MCP config JSON/);
  } finally {
    await runtime.close();
  }
}

function testEncodesAndDecodesToolNames() {
  const encoded = encodeMcpToolName("chrome-devtools", "take_snapshot");
  assert.equal(encoded, "mcp__chrome-devtools__take_snapshot");
  assert.deepEqual(decodeMcpToolName(encoded), {
    serverName: "chrome-devtools",
    toolName: "take_snapshot"
  });
}

function testTruncatesToolNamesWithoutLosingShape() {
  const encoded = encodeMcpToolName(
    "very-long-server-name-that-needs-a-limit",
    "very_long_tool_name_that_also_needs_to_be_shortened_for_openai_function_names"
  );
  assert.equal(encoded.length <= 64, true);
  assert.match(encoded, /^mcp__[^_].+__[^_].+/);
  assert.notEqual(decodeMcpToolName(encoded), undefined);
}

async function testRuntimeUsesStdioServerTools() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-runtime-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  try {
    const schemas = await runtime.getToolSchemas({ initialize: true });
    assert.equal(getFunctionToolName(schemas[0]), "mcp__mock__echo");

    const result = await runtime.executeToolCall("mcp__mock__echo", { text: "hello" }, {
      requestApproval: async () => true
    }) as {
      status: string;
      structuredContent?: { echoed?: string };
      content: Array<{ type: string; text?: string }>;
    };

    assert.equal(result.status, "completed");
    assert.equal(result.structuredContent?.echoed, "hello");
    assert.equal(result.content[0]?.text, "echo:hello");
  } finally {
    await runtime.close();
  }
}

async function testRuntimeStatusDoesNotInitializeServersByDefault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-status-lazy-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  try {
    const status = await runtime.getStatus();
    assert.equal(status.servers[0]?.status, "not_initialized");
    assert.equal(runtime.canExecuteTool("mcp__mock__echo"), false);

    const initializedStatus = await runtime.getStatus({ initialize: true });
    assert.equal(initializedStatus.servers[0]?.status, "connected");
    assert.equal(runtime.canExecuteTool("mcp__mock__echo"), true);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeToolSchemasDoNotInitializeServersByDefault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-schemas-lazy-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  try {
    assert.deepEqual(await runtime.getToolSchemas(), []);
    assert.equal((await runtime.getStatus()).servers[0]?.status, "not_initialized");

    const schemas = await runtime.getToolSchemas({ initialize: true });
    assert.equal(getFunctionToolName(schemas[0]), "mcp__mock__echo");
    assert.equal((await runtime.getStatus()).servers[0]?.status, "connected");
  } finally {
    await runtime.close();
  }
}

async function testRuntimeClearsToolIndexOnClose() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-close-index-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  const schemas = await runtime.getToolSchemas({ initialize: true });
  const toolName = getFunctionToolName(schemas[0]);
  if (!toolName) {
    throw new Error("Expected MCP runtime to expose a function tool name.");
  }
  assert.equal(toolName, "mcp__mock__echo");
  assert.equal(runtime.canExecuteTool(toolName), true);

  await runtime.close();
  assert.equal(runtime.canExecuteTool(toolName), false);
}

async function testRuntimeTimesOutHangingToolDiscovery() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-hanging-tools-"));
  const fixture = getMcpFixtureCommand("hangingToolsMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        hanging: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 1_000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  try {
    const startedAt = Date.now();
    const schemas = await runtime.getToolSchemas({ initialize: true });
    assert.deepEqual(schemas, []);
    assert.equal(Date.now() - startedAt < 2_000, true);

    const status = await runtime.getStatus();
    assert.equal(status.servers[0]?.status, "error");
    assert.match(status.servers[0]?.error ?? "", /did not list tools in time|timed out/i);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeCloseClearsInitializingState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-close-initializing-"));
  const fixture = getMcpFixtureCommand("hangingToolsMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        hanging: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5_000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
    const initializing = runtime.getToolSchemas({ initialize: true }).catch(() => []);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await runtime.close();

  const status = await runtime.getStatus();
  assert.equal(status.servers[0]?.status, "error");
  assert.match(status.servers[0]?.error ?? "", /closed during initialization/i);
  assert.equal(runtime.canExecuteTool("mcp__hanging__echo"), false);
  await initializing;
}

async function testRuntimeCanAbortToolDiscovery() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-abort-tools-"));
  const fixture = getMcpFixtureCommand("hangingToolsMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        hanging: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5_000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  const controller = new AbortController();
  setTimeout(() => controller.abort("test-abort"), 25);
  try {
    await assert.rejects(
      () => runtime.getToolSchemas({ abortSignal: controller.signal, initialize: true }),
      /interrupted|abort/i
    );
  } finally {
    await runtime.close();
  }
}

async function testRuntimeCanRetryAfterAbortedToolDiscovery() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-retry-after-abort-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5_000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  const controller = new AbortController();
  controller.abort("test-abort-before-start");

  try {
    await assert.rejects(
      () => runtime.getToolSchemas({ abortSignal: controller.signal, initialize: true }),
      /interrupted|abort/i
    );

    const schemas = await runtime.getToolSchemas({ initialize: true });
    assert.equal(getFunctionToolName(schemas[0]), "mcp__mock__echo");
    const status = await runtime.getStatus();
    assert.equal(status.servers[0]?.status, "connected");
  } finally {
    await runtime.close();
  }
}

async function testRuntimeListsAndReadsResources() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-resources-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: fixture.command,
          args: fixture.args,
          startup_timeout_ms: 5000
        }
      }
    }),
    "utf8"
  );

  const runtime = await createProjectMcpRuntime(root);
  try {
    const listed = await runtime.listResources({ serverName: "mock" });
    assert.equal(listed.resourceCount, 2);
    assert.equal(listed.servers[0]?.resources[0]?.uri, "mock://text");

    const status = await runtime.getStatus();
    assert.equal(status.servers[0]?.status, "connected");
    assert.equal(status.servers[0]?.capabilities.resources, true);

    const text = await runtime.readResource("mock", "mock://text", { maxTextChars: 20 });
    assert.equal(text.status, "completed");
    assert.equal(text.contents[0]?.type, "text");
    assert.equal(text.contents[0]?.type === "text" ? text.contents[0].text : "", "hello resource");

    const blob = await runtime.readResource("mock", "mock://blob");
    assert.equal(blob.status, "completed");
    assert.equal(blob.contents[0]?.type, "blob");
    const outputPath = blob.contents[0]?.type === "blob" ? blob.contents[0].outputPath : "";
    assert.equal(outputPath.startsWith(path.join(root, ".alyce", "mcp-output")), true);
    assert.deepEqual([...await fs.readFile(outputPath)], [1, 2, 3, 4]);

    const secondBlob = await runtime.readResource("mock", "mock://blob");
    const secondOutputPath = secondBlob.contents[0]?.type === "blob"
      ? secondBlob.contents[0].outputPath
      : "";
    assert.notEqual(secondOutputPath, outputPath);
    assert.deepEqual([...await fs.readFile(secondOutputPath)], [1, 2, 3, 4]);
  } finally {
    await runtime.close();
  }
}

function getMcpFixtureCommand(name: McpFixtureName) {
  return {
    command: process.execPath,
    args: [
      path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve("src", "mcp", "fixtures", `${name}.ts`)
    ]
  };
}

void runTests();
