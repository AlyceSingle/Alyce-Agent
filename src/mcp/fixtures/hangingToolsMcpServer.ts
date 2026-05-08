import readline from "node:readline";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
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
          tools: {}
        },
        serverInfo: {
          name: "alyce-hanging-tools-mcp",
          version: "1.0.0"
        }
      }
    });
  }
});
