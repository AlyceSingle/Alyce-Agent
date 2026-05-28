import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFunctionToolName } from "../core/api/openaiFunctionTools.js";
import { loadMcpConfigState, loadProjectMcpConfig } from "./config.js";
import { createProjectMcpRuntime } from "./runtime.js";
import { decodeMcpToolName, encodeMcpToolName } from "./toolNames.js";

type McpFixtureName = "mockMcpServer" | "hangingToolsMcpServer";

async function runTests() {
  await testMissingMcpConfigReturnsEmptyServerSet();
  await testLoadsProjectMcpConfig();
  await testUntrustedProjectMcpConfigIsIgnored();
  await testLoadsMergedScopedMcpConfigState();
  await testLoadsRemoteMcpConfig();
  await testLoadsSseMcpConfig();
  await testRejectsInvalidMcpConfigSchema();
  await testRuntimeSurvivesInvalidMcpConfig();
  await testRuntimeIgnoresInvalidProjectMcpConfigWhenUntrusted();
  await testRuntimeHandlesMissingMcpConfig();
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
  await testRuntimeListsToolsAndReadsResources();
  await testRuntimeUsesConfiguredOutputDirectory();
  await testRuntimeListsPromptsAndTemplates();
  await testRuntimeHandlesToolElicitation();
  await testRuntimeApprovalPolicyCanDenyTool();
  await testRuntimeApprovalPolicyCanAllowTool();
  await testRuntimeApprovalPolicyToolOverrideWins();
  await testRuntimeExposureBudgetHidesDynamicTools();
  await testRuntimeCanExecuteNamedToolCalls();
  await testRuntimeNormalizesServerLookupNames();
  await testRuntimePersistsEnableDisableAndRemove();
  console.log("MCP tests passed");
}

async function testMissingMcpConfigReturnsEmptyServerSet() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-missing-config-"));
  const config = await loadProjectMcpConfig(root);

  assert.deepEqual(config, { mcpServers: {} });
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

async function testUntrustedProjectMcpConfigIsIgnored() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-untrusted-config-"));
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        project: {
          command: "project-cmd"
        }
      }
    }),
    "utf8"
  );

  const state = await loadMcpConfigState(root, {
    trustedProject: false
  });

  assert.deepEqual(Object.keys(state.configs.project.mcpServers), []);
  assert.deepEqual(Object.keys(state.effective.mcpServers), []);
}

async function testLoadsMergedScopedMcpConfigState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-scoped-state-"));
  const homeDirectory = path.join(root, "home");
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.mkdir(path.join(homeDirectory, ".alyce"), { recursive: true });

  await fs.writeFile(
    path.join(homeDirectory, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "user-only": {
          command: "${TEST_MCP_COMMAND}",
          cwd: "."
        },
        shared: {
          command: "user-cmd"
        }
      }
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        shared: {
          command: "project-cmd",
          cwd: "./project-subdir"
        },
        "project-only": {
          url: "https://example.com/%TEST_MCP_PATH%"
        }
      }
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.local.json"),
    JSON.stringify({
      mcpServers: {
        "local-only": {
          type: "sse",
          url: "https://example.com/$TEST_MCP_PATH"
        }
      }
    }),
    "utf8"
  );

  const state = await loadMcpConfigState(root, {
    env: {
      ...process.env,
      TEST_MCP_COMMAND: "expanded-user-cmd",
      TEST_MCP_PATH: "events"
    },
    homeDirectory
  });

  assert.equal(state.sources["user-only"], "user");
  assert.equal(state.sources.shared, "project");
  assert.equal(state.sources["project-only"], "project");
  assert.equal(state.sources["local-only"], "local");
  assert.equal(
    state.effective.mcpServers["user-only"]?.type === "stdio"
      ? state.effective.mcpServers["user-only"].command
      : "",
    "expanded-user-cmd"
  );
  assert.equal(
    state.effective.mcpServers["user-only"]?.type === "stdio"
      ? state.effective.mcpServers["user-only"].cwd
      : "",
    homeDirectory
  );
  assert.equal(
    state.effective.mcpServers.shared?.type === "stdio"
      ? state.effective.mcpServers.shared.command
      : "",
    "project-cmd"
  );
  assert.equal(
    state.effective.mcpServers.shared?.type === "stdio"
      ? state.effective.mcpServers.shared.cwd
      : "",
    path.join(root, "project-subdir")
  );
  assert.equal(
    state.effective.mcpServers["project-only"]?.type === "streamable_http"
      ? state.effective.mcpServers["project-only"].url
      : "",
    "https://example.com/events"
  );
  assert.equal(
    state.effective.mcpServers["local-only"]?.type === "sse"
      ? state.effective.mcpServers["local-only"].url
      : "",
    "https://example.com/events"
  );
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

async function testLoadsSseMcpConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-sse-config-"));
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        events: {
          type: "sse",
          url: "https://example.com/events",
          headers: {
            authorization: "Bearer token"
          }
        }
      }
    }),
    "utf8"
  );

  const config = await loadProjectMcpConfig(root);
  const events = config.mcpServers.events;
  assert.equal(events?.type, "sse");
  assert.equal(events?.type === "sse" ? events.url : undefined, "https://example.com/events");
  assert.equal(events?.type === "sse" ? events.headers?.authorization : undefined, "Bearer token");
}

async function testRejectsInvalidMcpConfigSchema() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-invalid-schema-"));
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".alyce", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        broken: {
          command: ""
        }
      }
    }),
    "utf8"
  );

  await assert.rejects(
    () => loadProjectMcpConfig(root),
    /Invalid MCP config .*mcpServers\.broken\.command/
  );
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
    assert.equal(status.servers[0]?.status, "failed");
    assert.match(status.servers[0]?.error ?? "", /Invalid MCP config JSON/);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeIgnoresInvalidProjectMcpConfigWhenUntrusted() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-untrusted-invalid-runtime-"));
  await fs.mkdir(path.join(root, ".alyce"), { recursive: true });
  await fs.writeFile(path.join(root, ".alyce", "mcp.json"), "{", "utf8");

  const runtime = await createProjectMcpRuntime(root, {
    trusted: false
  });
  try {
    assert.deepEqual(await runtime.getToolSchemas({ initialize: true }), []);
    assert.deepEqual(await runtime.getStatus(), { servers: [] });
  } finally {
    await runtime.close();
  }
}

async function testRuntimeHandlesMissingMcpConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-missing-runtime-"));

  const runtime = await createProjectMcpRuntime(root);
  try {
    assert.deepEqual(await runtime.getToolSchemas({ initialize: true }), []);
    assert.deepEqual(await runtime.getStatus(), { servers: [] });
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
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

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
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

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
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

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
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

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
  await writeProjectConfig(root, {
    hanging: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 1_000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    const startedAt = Date.now();
    const schemas = await runtime.getToolSchemas({ initialize: true });
    assert.deepEqual(schemas, []);
    assert.equal(Date.now() - startedAt < 2_000, true);

    const status = await runtime.getStatus();
    assert.equal(status.servers[0]?.status, "failed");
    assert.match(status.servers[0]?.error ?? "", /did not list tools in time|timed out/i);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeCloseClearsInitializingState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-close-initializing-"));
  const fixture = getMcpFixtureCommand("hangingToolsMcpServer");
  await writeProjectConfig(root, {
    hanging: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5_000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  const initializing = runtime.getToolSchemas({ initialize: true }).catch(() => []);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await runtime.close();

  const status = await runtime.getStatus();
  assert.equal(status.servers[0]?.status, "failed");
  assert.match(status.servers[0]?.error ?? "", /closed during initialization/i);
  assert.equal(runtime.canExecuteTool("mcp__hanging__echo"), false);
  await initializing;
}

async function testRuntimeCanAbortToolDiscovery() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-abort-tools-"));
  const fixture = getMcpFixtureCommand("hangingToolsMcpServer");
  await writeProjectConfig(root, {
    hanging: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5_000
    }
  });

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
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5_000
    }
  });

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

async function testRuntimeListsToolsAndReadsResources() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-resources-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    const tools = await runtime.listTools({ serverName: "mock" });
    assert.equal(tools.toolCount, 2);
    assert.deepEqual(
      tools.servers[0]?.tools.map((tool) => tool.name).sort(),
      ["collect_deploy_info", "echo"]
    );
    assert.equal(
      tools.servers[0]?.tools.some((tool) => tool.exposedName === "mcp__mock__echo"),
      true
    );

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
  } finally {
    await runtime.close();
  }
}

async function testRuntimeUsesConfiguredOutputDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-output-dir-"));
  const outputDirectory = path.join(root, "home", ".alyce", "workspace-state", "workspace", "mcp-output");
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

  const runtime = await createProjectMcpRuntime(root, {
    outputDirectory
  });
  try {
    const blob = await runtime.readResource("mock", "mock://blob");
    const outputPath = blob.contents[0]?.type === "blob" ? blob.contents[0].outputPath : "";
    assert.equal(outputPath.startsWith(outputDirectory), true);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeListsPromptsAndTemplates() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-prompts-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    const prompts = await runtime.listPrompts({ serverName: "mock" });
    assert.equal(prompts.promptCount, 1);
    assert.equal(prompts.servers[0]?.prompts[0]?.name, "summarize_release");

    const prompt = await runtime.getPrompt("mock", "summarize_release", {
      topic: "release notes"
    });
    assert.equal(prompt.status, "completed");
    assert.equal(prompt.messages[0]?.content[0]?.type, "text");
    assert.equal(
      prompt.messages[0]?.content[0]?.type === "text"
        ? prompt.messages[0].content[0].text
        : "",
      "Summarize release notes."
    );

    const templates = await runtime.listResourceTemplates({ serverName: "mock" });
    assert.equal(templates.resourceTemplateCount, 1);
    assert.equal(
      templates.servers[0]?.resourceTemplates[0]?.uriTemplate,
      "mock://repo/{owner}/{name}"
    );
  } finally {
    await runtime.close();
  }
}

async function testRuntimeHandlesToolElicitation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-elicitation-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  runtime.setInteractionHandlers?.({
    requestElicitation: async (request) => {
      assert.equal(request.mode, "form");
      return {
        action: "accept",
        content: {
          environment: "production",
          include_logs: true
        }
      };
    }
  });

  try {
    await runtime.getToolSchemas({ initialize: true });
    const result = await runtime.executeToolCall("mcp__mock__collect_deploy_info", {
      label: "release"
    }, {
      requestApproval: async () => true
    }) as {
      status: string;
      structuredContent?: { environment?: string; includeLogs?: boolean };
      content: Array<{ type: string; text?: string }>;
    };

    assert.equal(result.status, "completed");
    assert.equal(result.structuredContent?.environment, "production");
    assert.equal(result.structuredContent?.includeLogs, true);
    assert.equal(result.content[0]?.text, "deploy:production:with-logs");
  } finally {
    await runtime.close();
  }
}

async function testRuntimeApprovalPolicyCanDenyTool() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-approval-deny-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000,
      approval: {
        default: "deny"
      }
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    await runtime.getToolSchemas({ initialize: true });
    let approvalCount = 0;
    await assert.rejects(
      () => runtime.executeNamedToolCall("mock", "echo", { text: "hello" }, {
        requestApproval: async () => {
          approvalCount += 1;
          return true;
        }
      }),
      /denied by MCP approval policy/
    );
    assert.equal(approvalCount, 0);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeApprovalPolicyCanAllowTool() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-approval-allow-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000,
      approval: {
        default: "allow"
      }
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    await runtime.getToolSchemas({ initialize: true });
    let approvalCount = 0;
    const result = await runtime.executeNamedToolCall("mock", "echo", { text: "hello" }, {
      requestApproval: async () => {
        approvalCount += 1;
        return true;
      }
    }) as {
      status: string;
      structuredContent?: { echoed?: string };
    };

    assert.equal(result.status, "completed");
    assert.equal(result.structuredContent?.echoed, "hello");
    assert.equal(approvalCount, 0);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeApprovalPolicyToolOverrideWins() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-approval-override-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000,
      approval: {
        default: "allow",
        tools: {
          echo: "deny"
        }
      }
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    await runtime.getToolSchemas({ initialize: true });
    await assert.rejects(
      () => runtime.executeNamedToolCall("mock", "echo", { text: "hello" }, {
        requestApproval: async () => true
      }),
      /denied by MCP approval policy/
    );
  } finally {
    await runtime.close();
  }
}

async function testRuntimeExposureBudgetHidesDynamicTools() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-budgeted-tools-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  const servers = Object.fromEntries(
    Array.from({ length: 13 }, (_, index) => [
      `mock-${index + 1}`,
      {
        command: fixture.command,
        args: fixture.args,
        startup_timeout_ms: 5000
      }
    ])
  );
  await writeProjectConfig(root, servers);

  const runtime = await createProjectMcpRuntime(root);
  try {
    const schemas = await runtime.getToolSchemas({ initialize: true });
    assert.deepEqual(schemas, []);

    const status = await runtime.getStatus();
    assert.equal(status.servers.length, 13);
    assert.equal(status.servers.every((server) => server.toolExposure === "budgeted"), true);
    assert.equal(status.servers.every((server) => server.directToolCount === 0), true);
    assert.equal(status.servers.every((server) => server.hiddenToolCount === 2), true);
  } finally {
    await runtime.close();
  }
}

async function testRuntimeCanExecuteNamedToolCalls() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-named-tool-call-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    await runtime.getToolSchemas({ initialize: true });
    const result = await runtime.executeNamedToolCall("mock", "echo", { text: "hello" }, {
      requestApproval: async () => true
    }) as {
      status: string;
      structuredContent?: { echoed?: string };
      content: Array<{ text?: string }>;
    };

    assert.equal(result.status, "completed");
    assert.equal(result.structuredContent?.echoed, "hello");
    assert.equal(result.content[0]?.text, "echo:hello");
  } finally {
    await runtime.close();
  }
}

async function testRuntimeNormalizesServerLookupNames() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-normalized-lookups-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    const tools = await runtime.listTools({ serverName: "MOCK" });
    assert.equal(tools.toolCount, 2);
    assert.equal(tools.servers[0]?.server, "mock");

    const prompt = await runtime.getPrompt("MOCK", "summarize_release", {
      topic: "release notes"
    });
    assert.equal(prompt.status, "completed");

    const resource = await runtime.readResource("MOCK", "mock://text", { maxTextChars: 20 });
    assert.equal(resource.status, "completed");

    const result = await runtime.executeNamedToolCall("MOCK", "echo", { text: "hello" }, {
      requestApproval: async () => true
    }) as {
      status: string;
      structuredContent?: { echoed?: string };
    };
    assert.equal(result.status, "completed");
    assert.equal(result.structuredContent?.echoed, "hello");
  } finally {
    await runtime.close();
  }
}

async function testRuntimePersistsEnableDisableAndRemove() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-mcp-mutations-"));
  const fixture = getMcpFixtureCommand("mockMcpServer");
  await writeProjectConfig(root, {
    mock: {
      command: fixture.command,
      args: fixture.args,
      startup_timeout_ms: 5000
    }
  });

  const runtime = await createProjectMcpRuntime(root);
  try {
    await runtime.setServerEnabled("mock", false);
    let status = await runtime.getStatus();
    assert.equal(status.servers[0]?.status, "disabled");
    assert.equal(status.servers[0]?.enabled, false);

    let config = await loadProjectMcpConfig(root);
    assert.equal(config.mcpServers.mock?.enabled, false);

    await runtime.setServerEnabled("mock", true);
    status = await runtime.getStatus();
    assert.equal(status.servers[0]?.status, "not_initialized");
    assert.equal(status.servers[0]?.enabled, true);

    await runtime.addServer("remote", {
      type: "streamable_http",
      url: "https://example.com/mcp"
    }, {
      scope: "local"
    });
    status = await runtime.getStatus();
    assert.equal(status.servers.some((server) => server.name === "remote" && server.scope === "local"), true);

    await runtime.removeServer("remote", { scope: "local" });
    status = await runtime.getStatus();
    assert.equal(status.servers.some((server) => server.name === "remote"), false);
  } finally {
    await runtime.close();
  }
}

async function writeProjectConfig(
  workspaceRoot: string,
  servers: Record<string, Record<string, unknown>>
) {
  await fs.mkdir(path.join(workspaceRoot, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".alyce", "mcp.json"),
    JSON.stringify({ mcpServers: servers }),
    "utf8"
  );
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
