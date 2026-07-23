import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createPersistentMcpOAuthProvider } from "./auth.js";
import type { McpServerConfig } from "./types.js";
import type { McpServerRuntime } from "./runtimeTypes.js";
import { setServerTools } from "./schema.js";
import { resolveMcpTimeout, withTimeout } from "./timeouts.js";

// 传输层创建、关闭与重连定时器清理。

export function createTransport(
  serverName: string,
  server: McpServerConfig,
  workspaceRoot: string,
  authProvider?: OAuthClientProvider
): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
  if (server.type === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: server.env,
      cwd: server.cwd ?? workspaceRoot,
      stderr: "pipe"
    });
  }

  const remoteAuthProvider = authProvider ?? createPersistentMcpOAuthProvider({
    serverName,
    serverConfig: server
  });
  const headers: Record<string, string> = {
    ...(server.headers ?? {})
  };
  if (server.bearer_token_env_var) {
    const token = process.env[server.bearer_token_env_var];
    if (token?.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
  }

  const requestInit = Object.keys(headers).length > 0
    ? { headers }
    : undefined;
  if (server.type === "sse") {
    return new SSEClientTransport(new URL(server.url), {
      requestInit,
      authProvider: remoteAuthProvider
    });
  }

  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit,
    authProvider: remoteAuthProvider
  });
}
export function releaseInitializingServer(server: McpServerRuntime, runId: number) {
  if (server.initializationRunId === runId) {
    server.initializing = undefined;
  }
}

export function isCurrentInitializationRun(server: McpServerRuntime, runId: number) {
  return server.initializationRunId === runId;
}

export async function closeServerTransport(server: McpServerRuntime) {
  clearReconnectTimer(server);
  await closeTransportWithTimeout(server, server.transport);
  server.client = undefined;
  server.transport = undefined;
  setServerTools(server, []);
}

export async function closeTransportWithTimeout(
  server: McpServerRuntime,
  transport: Transport | undefined
) {
  if (!transport) {
    return;
  }

  try {
    server.suppressCloseHandling = true;
    const closeResult = transport.close();
    const closeTimeoutMs = resolveMcpTimeout(server, "close");
    await withTimeout(
      closeResult instanceof Promise ? closeResult : Promise.resolve(closeResult),
      closeTimeoutMs,
      `MCP server '${server.name}' did not close in time.`
    );
  } catch {
    // close is best-effort
  } finally {
    server.suppressCloseHandling = false;
  }
}

export function closeTransportQuietly(transport: Transport) {
  try {
    const closeResult = transport.close();
    if (closeResult instanceof Promise) {
      void closeResult.catch(() => undefined);
    }
  } catch {
    // close is best-effort
  }
}

export function clearReconnectTimer(server: McpServerRuntime) {
  if (!server.reconnectTimer) {
    server.nextReconnectAt = undefined;
    return;
  }

  clearTimeout(server.reconnectTimer);
  server.reconnectTimer = undefined;
  server.nextReconnectAt = undefined;
}

