import readline from "node:readline";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: {
    arguments?: {
      text?: string;
    };
    uri?: string;
  };
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line) as JsonRpcMessage;
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
          resources: {}
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
          }
        ]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
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
