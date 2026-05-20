import readline from "node:readline";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    uri?: string;
    requestedSchema?: unknown;
    message?: string;
  };
  result?: {
    action?: string;
    content?: Record<string, unknown>;
  };
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

let pendingToolCallId: string | number | null | undefined;
let pendingElicitationId: string | null = null;

rl.on("line", (line) => {
  const message = JSON.parse(line) as JsonRpcMessage;
  if (!message.method && message.id === pendingElicitationId && pendingToolCallId !== undefined) {
    const content = message.result?.content ?? {};
    const environment = typeof content.environment === "string" ? content.environment : "unknown";
    const includeLogs = content.include_logs === true ? "with-logs" : "without-logs";
    send({
      jsonrpc: "2.0",
      id: pendingToolCallId,
      result: {
        content: [
          {
            type: "text",
            text: `deploy:${environment}:${includeLogs}`
          }
        ],
        structuredContent: {
          environment,
          includeLogs: content.include_logs === true
        }
      }
    });
    pendingToolCallId = undefined;
    pendingElicitationId = null;
    return;
  }

  if (!("id" in message)) {
    return;
  }

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        serverInfo: {
          name: "alyce-mock-mcp",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo input text.",
            inputSchema: {
              type: "object",
              properties: {
                text: {
                  type: "string"
                }
              },
              required: ["text"]
            }
          },
          {
            name: "collect_deploy_info",
            description: "Collect deploy settings through elicitation.",
            inputSchema: {
              type: "object",
              properties: {
                label: {
                  type: "string"
                }
              },
              required: ["label"]
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    if (message.params?.name === "collect_deploy_info") {
      pendingToolCallId = message.id;
      pendingElicitationId = "mock-elicitation-1";
      send({
        jsonrpc: "2.0",
        id: pendingElicitationId,
        method: "elicitation/create",
        params: {
          message: "Choose a deploy target for this run.",
          requestedSchema: {
            type: "object",
            properties: {
              environment: {
                type: "string",
                title: "Environment",
                enum: ["staging", "production"],
                default: "staging"
              },
              include_logs: {
                type: "boolean",
                title: "Include Logs",
                default: true
              }
            },
            required: ["environment", "include_logs"]
          }
        }
      });
      return;
    }

    const text = message.params?.arguments?.text ?? "";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: `echo:${text}`
          }
        ],
        structuredContent: {
          echoed: text
        }
      }
    });
    return;
  }

  if (message.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        prompts: [
          {
            name: "summarize_release",
            description: "Summarize a release topic.",
            arguments: [
              {
                name: "topic",
                required: true
              }
            ]
          }
        ]
      }
    });
    return;
  }

  if (message.method === "prompts/get") {
    const topic = typeof message.params?.arguments?.topic === "string"
      ? message.params.arguments.topic
      : "release notes";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        description: "Mock prompt payload.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Summarize ${topic}.`
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resources: [
          {
            uri: "mock://text",
            name: "Text Fixture",
            description: "A text fixture resource.",
            mimeType: "text/plain",
            size: 12
          },
          {
            uri: "mock://blob",
            name: "Blob Fixture",
            description: "A binary fixture resource.",
            mimeType: "application/octet-stream",
            size: 4
          }
        ]
      }
    });
    return;
  }

  if (message.method === "resources/templates/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resourceTemplates: [
          {
            uriTemplate: "mock://repo/{owner}/{name}",
            name: "Repository",
            mimeType: "application/json"
          }
        ]
      }
    });
    return;
  }

  if (message.method === "resources/read") {
    const uri = message.params?.uri;
    if (uri === "mock://blob") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contents: [
            {
              uri: "mock://blob",
              mimeType: "application/octet-stream",
              blob: Buffer.from([1, 2, 3, 4]).toString("base64")
            }
          ]
        }
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [
          {
            uri: "mock://text",
            mimeType: "text/plain",
            text: "hello resource"
          }
        ]
      }
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unknown method: ${message.method}`
    }
  });
});
