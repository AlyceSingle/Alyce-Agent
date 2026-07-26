import assert from "node:assert/strict";
import type OpenAI from "openai";
import { TurnInterruptedError } from "../abort.js";
import { getFunctionToolNames } from "../api/openaiFunctionTools.js";
import { runAgentTurn, withSerializedApprovals } from "./runAgentTurn.js";
import type { ToolApprovalRequest, ToolExecutionContext } from "../../tools.js";
import type { UsageRecordInput } from "../usage/types.js";
import { ContextBudgetService } from "../context/contextBudget.js";

function createTestContext(
  abortSignal: AbortSignal,
  patch: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    workspaceRoot: process.cwd(),
    allowedRoots: [process.cwd()],
    requestApproval: async () => true,
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined,
    ...patch
  };
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

async function runTests() {
  await testInterruptedToolCallDoesNotLeaveUnansweredAssistantMessage();
  await testRejectedToolApprovalReturnsToolResultAndContinues();
  await testToolCallAssistantContentIsNotThinking();
  await testExplicitReasoningFieldIsThinking();
  await testUsageCallbackIncludesTurnMetadata();
  await testMcpStatusRefreshesToolsBeforeNextStep();
  await testToolSchemaRefreshFailureContinuesWithWarning();
  await testMaxStepsLeavesAnsweredToolCallPair();
  await testContextBudgetPublishesAfterFinalReply();
  await testSerializedApprovalsNeverOverlap();
  await testReadOnlyToolCallsRunAsParallelBatch();
  console.log("runAgentTurn tests passed");
}

async function testInterruptedToolCallDoesNotLeaveUnansweredAssistantMessage() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "AskUserQuestion",
                  arguments: JSON.stringify({
                    questions: [{
                      header: "Choice",
                      question: "Pick one",
                      options: [
                        {
                          label: "A",
                          description: "First"
                        },
                        {
                          label: "B",
                          description: "Second"
                        }
                      ]
                    }]
                  })
                }
              }]
            }
          }]
        })
      }
    }
  } as unknown as OpenAI;

  await assert.rejects(
    () => runAgentTurn(client, messages, {
      model: "gpt-test",
      maxSteps: 1,
      abortSignal: controller.signal,
      context: createTestContext(controller.signal, {
        askUserQuestions: async () => {
          controller.abort("test-abort");
          throw new TurnInterruptedError("test-abort");
        }
      })
    }),
    TurnInterruptedError
  );

  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
}

async function testToolCallAssistantContentIsNotThinking() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  let requestCount = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          requestCount += 1;
          if (requestCount === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "I will inspect package.json.",
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "Read",
                      arguments: JSON.stringify({ file_path: "package.json", limit: 1 })
                    }
                  }]
                }
              }]
            };
          }

          return {
            choices: [{
              message: {
                role: "assistant",
                content: "done"
              }
            }]
          };
        }
      }
    }
  } as unknown as OpenAI;
  const thinkingEvents: string[] = [];

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 2,
    tools: [],
    abortSignal: controller.signal,
    context: createTestContext(controller.signal),
    onThinking: (content) => {
      thinkingEvents.push(content);
    }
  });

  assert.equal(reply, "done");
  assert.deepEqual(thinkingEvents, []);
}

async function testExplicitReasoningFieldIsThinking() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "answer",
              reasoning_content: "reasoning summary"
            }
          }]
        })
      }
    }
  } as unknown as OpenAI;
  const thinkingEvents: string[] = [];

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 1,
    tools: [],
    abortSignal: controller.signal,
    context: createTestContext(controller.signal),
    onThinking: (content) => {
      thinkingEvents.push(content);
    }
  });

  assert.equal(reply, "answer");
  assert.deepEqual(thinkingEvents, ["reasoning summary"]);
}

async function testUsageCallbackIncludesTurnMetadata() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "answer"
            }
          }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15
          }
        })
      }
    }
  } as unknown as OpenAI;
  const usageEvents: UsageRecordInput[] = [];

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 1,
    tools: [],
    abortSignal: controller.signal,
    context: createTestContext(controller.signal),
    usageSource: "main",
    usageTurnId: "turn-1",
    onUsage: (event) => {
      usageEvents.push(event);
    }
  });

  assert.equal(reply, "answer");
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0]?.requestedModel, "gpt-test");
  assert.equal(usageEvents[0]?.usage?.total_tokens, 15);
  assert.equal(usageEvents[0]?.retryCount, 0);
  assert.equal(usageEvents[0]?.source, "main");
  assert.equal(usageEvents[0]?.turnId, "turn-1");
  assert.ok((usageEvents[0]?.durationMs ?? -1) >= 0);
}

async function testMcpStatusRefreshesToolsBeforeNextStep() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  const toolNamesByRequest: string[][] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] }) => {
          toolNamesByRequest.push(getFunctionToolNames(request.tools));
          if (toolNamesByRequest.length === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "McpStatus",
                      arguments: JSON.stringify({ initialize: false })
                    }
                  }]
                }
              }]
            };
          }

          return {
            choices: [{
              message: {
                role: "assistant",
                content: "done"
              }
            }]
          };
        }
      }
    }
  } as unknown as OpenAI;

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 2,
    abortSignal: controller.signal,
    tools: [{
      type: "function",
      function: {
        name: "McpStatus",
        description: "status",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    }],
    refreshTools: async () => [
      {
        type: "function",
        function: {
          name: "McpStatus",
          description: "status",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "mcp__mock__echo",
          description: "echo",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      }
    ],
    context: createTestContext(controller.signal, {
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
    })
  });

  assert.equal(reply, "done");
  assert.deepEqual(toolNamesByRequest, [
    ["McpStatus"],
    ["McpStatus", "mcp__mock__echo"]
  ]);
}

async function testRejectedToolApprovalReturnsToolResultAndContinues() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  let requestCount = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          requestCount += 1;
          if (requestCount === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "WebFetch",
                      arguments: JSON.stringify({
                        url: "https://example.com",
                        prompt: "Summarize"
                      })
                    }
                  }]
                }
              }]
            };
          }

          const toolMessage = messages.find((message) => message.role === "tool");
          assert.ok(toolMessage);
          const content = typeof toolMessage.content === "string" ? toolMessage.content : "";
          const parsed = JSON.parse(content) as {
            ok: boolean;
            status: string;
            error: { type: string; status: string; message: string };
          };
          assert.equal(parsed.ok, false);
          assert.equal(parsed.status, "rejected");
          assert.equal(parsed.error.type, "permission_rejected");

          return {
            choices: [{
              message: {
                role: "assistant",
                content: "approval was rejected"
              }
            }]
          };
        }
      }
    }
  } as unknown as OpenAI;

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 2,
    abortSignal: controller.signal,
    context: createTestContext(controller.signal, {
      requestApproval: async () => false
    })
  });

  assert.equal(reply, "approval was rejected");
  assert.deepEqual(messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    "tool",
    "assistant"
  ]);
}

async function testToolSchemaRefreshFailureContinuesWithWarning() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  let requestCount = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          requestCount += 1;
          if (requestCount === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "McpStatus",
                      arguments: JSON.stringify({ initialize: false })
                    }
                  }]
                }
              }]
            };
          }

          assert.equal(messages.at(-1)?.role, "system");
          assert.match(String((messages.at(-1) as { content?: unknown }).content), /Tool schema refresh failed/);

          return {
            choices: [{
              message: {
                role: "assistant",
                content: "continued"
              }
            }]
          };
        }
      }
    }
  } as unknown as OpenAI;

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 2,
    abortSignal: controller.signal,
    tools: [{
      type: "function",
      function: {
        name: "McpStatus",
        description: "status",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    }],
    refreshTools: async () => {
      throw new Error("mock refresh failure");
    },
    context: createTestContext(controller.signal, {
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
    })
  });

  assert.equal(reply, "continued");
}

async function testMaxStepsLeavesAnsweredToolCallPair() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "TaskList",
                  arguments: JSON.stringify({})
                }
              }]
            }
          }]
        })
      }
    }
  } as unknown as OpenAI;

  await assert.rejects(
    () => runAgentTurn(client, messages, {
      model: "gpt-test",
      maxSteps: 1,
      abortSignal: controller.signal,
      context: createTestContext(controller.signal, {
        listSubagentTasks: () => []
      })
    }),
    /Max tool steps reached/
  );

  assert.deepEqual(messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    "tool"
  ]);
}


async function testContextBudgetPublishesAfterFinalReply() {
  const controller = new AbortController();
  const longReply = "x".repeat(8_000);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "system"
    },
    {
      role: "user",
      content: "ask"
    }
  ];
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: longReply
            }
          }],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 2_000,
            total_tokens: 2_040
          }
        })
      }
    }
  } as unknown as OpenAI;
  const snapshots: number[] = [];
  const budgetService = new ContextBudgetService();

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 1,
    tools: [],
    abortSignal: controller.signal,
    context: createTestContext(controller.signal),
    contextBudgetService: budgetService,
    onContextBudget: (snapshot) => {
      snapshots.push(snapshot.estimatedInputTokens);
    }
  });

  assert.equal(reply, longReply);
  assert.ok(snapshots.length >= 2, "expected preflight and post-reply budget publishes");
  assert.ok(
    snapshots[snapshots.length - 1]! > snapshots[0]!,
    `final budget should include assistant text: ${snapshots.join(",")}`
  );
  assert.equal(messages.at(-1)?.role, "assistant");
}

async function testSerializedApprovalsNeverOverlap() {
  const controller = new AbortController();
  let inFlight = 0;
  let maxInFlight = 0;
  let callCount = 0;
  const context = createTestContext(controller.signal, {
    requestApproval: async () => {
      callCount += 1;
      const callIndex = callCount;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      if (callIndex === 2) {
        throw new Error("approval dialog crashed");
      }
      return true;
    }
  });
  const wrapped = withSerializedApprovals(context);
  const request: ToolApprovalRequest = {
    kind: "file-read",
    toolName: "Read",
    title: "test",
    summary: "test",
    details: []
  };

  const results = await Promise.allSettled([
    wrapped.requestApproval(request),
    wrapped.requestApproval(request),
    wrapped.requestApproval(request)
  ]);

  assert.equal(maxInFlight, 1, "approval prompts must never overlap");
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  // 第 2 个审批抛错后，队列不能卡死，第 3 个仍要执行。
  assert.equal(results[2]?.status, "fulfilled");
  assert.equal(callCount, 3);
}

async function testReadOnlyToolCallsRunAsParallelBatch() {
  const controller = new AbortController();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: "system" },
    { role: "user", content: "read files" }
  ];
  const events: string[] = [];
  let requestCount = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          requestCount += 1;
          if (requestCount === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "Read",
                        arguments: JSON.stringify({ file_path: "package.json" })
                      }
                    },
                    {
                      id: "call_2",
                      type: "function",
                      function: {
                        name: "Read",
                        arguments: JSON.stringify({ file_path: "README.md" })
                      }
                    },
                    {
                      id: "call_3",
                      type: "function",
                      function: {
                        name: "Glob",
                        arguments: JSON.stringify({ pattern: "*.md" })
                      }
                    }
                  ]
                }
              }]
            };
          }

          return {
            choices: [{
              message: {
                role: "assistant",
                content: "done"
              }
            }]
          };
        }
      }
    }
  } as unknown as OpenAI;

  const reply = await runAgentTurn(client, messages, {
    model: "gpt-test",
    maxSteps: 2,
    abortSignal: controller.signal,
    context: createTestContext(controller.signal),
    onToolCallStart: (toolName) => {
      events.push(`start:${toolName}`);
    },
    onToolCallResult: (toolName) => {
      events.push(`result:${toolName}`);
    }
  });

  assert.equal(reply, "done");
  // 并行批次：三个 start 全部先于任何 result 触发（串行模式下会是 start/result 交替）。
  assert.deepEqual(events.slice(0, 3), ["start:Read", "start:Read", "start:Glob"]);
  assert.equal(events.length, 6);

  // tool 消息按原调用顺序回填，id 一一对应。
  const toolMessages = messages.filter(
    (message): message is OpenAI.Chat.Completions.ChatCompletionToolMessageParam =>
      message.role === "tool"
  );
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), [
    "call_1",
    "call_2",
    "call_3"
  ]);
}

void runTests();
