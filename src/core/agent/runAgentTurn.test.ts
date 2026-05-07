import assert from "node:assert/strict";
import type OpenAI from "openai";
import { TurnInterruptedError } from "../abort.js";
import { runAgentTurn } from "./runAgentTurn.js";
import type { ToolExecutionContext } from "../../tools.js";

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

async function runTests() {
  await testInterruptedToolCallDoesNotLeaveUnansweredAssistantMessage();
  await testMcpStatusRefreshesToolsBeforeNextStep();
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
        create: async (request: { tools?: Array<{ function: { name: string } }> }) => {
          toolNamesByRequest.push((request.tools ?? []).map((tool) => tool.function.name));
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
    })
  });

  assert.equal(reply, "done");
  assert.deepEqual(toolNamesByRequest, [
    ["McpStatus"],
    ["McpStatus", "mcp__mock__echo"]
  ]);
}

void runTests();
