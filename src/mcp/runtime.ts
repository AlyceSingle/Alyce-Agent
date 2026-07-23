import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  type ElicitRequestParams,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isTurnInterruptedError,
  throwIfAborted,
  TurnInterruptedError
} from "../core/abort.js";
import type { JsonRecord, ToolApprovalRequest } from "../tools/types.js";
import {
  loadMcpConfigState,
  normalizeMcpServerName,
  removeMcpServerConfig,
  setScopedMcpServerEnabled,
  writeMcpServerConfig
} from "./config.js";
import {
  createMcpOAuthCallbackServer,
  createPersistentMcpOAuthProvider
} from "./auth.js";
import type {
  McpConfigMutationResult,
  McpConfigScope,
  McpConfigState,
  McpElicitationCompleteEvent,
  McpElicitationRequest,
  McpElicitationResponse,
  McpListPromptsResult,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpListToolsResult,
  McpLoginResult,
  McpPromptContent,
  McpPromptMessage,
  McpPromptResult,
  McpReadResourceContent,
  McpReadResourceResult,
  McpServerConfig,
  McpServerConnectionState,
  McpServerPromptList,
  McpServerResourceList,
  McpServerResourceTemplateList,
  McpServerStatus,
  McpServerToolList,
  McpStatusResult,
  McpToolRuntime
} from "./types.js";
import {
  DIRECT_MCP_TOOL_EXPOSURE_LIMIT,
  MCP_LOGIN_TIMEOUT_MS,
  MCP_PROMPT_TEXT_MAX_CHARS,
  MCP_RECONNECT_BASE_DELAY_MS,
  MCP_RECONNECT_MAX_DELAY_MS,
  type ChatCompletionTool,
  type InitializationReason,
  type McpRuntimeOperationOptions,
  type McpServerRuntime,
  type McpToolMetadata
} from "./runtimeTypes.js";
import {
  buildMcpToolApprovalRequest,
  classifyMcpToolImpact,
  resolveMcpToolApprovalAction
} from "./approval.js";
import {
  appendErrorChunk,
  buildRuntimeErrorMessage,
  classifyErrorStatus,
  createAbortRaceError,
  resolveMcpTimeout,
  trackServerOperation,
  truncate,
  withAbort,
  withTimeout
} from "./timeouts.js";
import {
  createToolSchema,
  listServerTools,
  mapListedTools,
  setServerTools
} from "./schema.js";
import {
  clearReconnectTimer,
  closeServerTransport,
  closeTransportQuietly,
  closeTransportWithTimeout,
  createTransport,
  isCurrentInitializationRun,
  releaseInitializingServer
} from "./transport.js";
import {
  extensionForMimeType,
  formatEndpoint,
  isServerEnabled,
  normalizeContent,
  normalizeElicitationRequest,
  normalizeElicitationResponse,
  normalizeMcpToolResult,
  normalizePromptSummary,
  normalizeRequestedServerName,
  normalizeResourceSummary,
  normalizeResourceTemplateSummary,
  sanitizeFileName
} from "./normalize.js";

// Project MCP runtime：server 生命周期 + 对外 McpToolRuntime API。
// 传输/schema/规范化/超时细节见同目录其它模块。

// Project MCP runtime：server 生命周期 + 对外 McpToolRuntime API。
// 传输/schema/规范化/超时细节见同目录其它模块。

export interface ProjectMcpRuntimeOptions {
  homeDirectory?: string;
  outputDirectory?: string;
  trusted?: boolean;
}

export async function createProjectMcpRuntime(
  workspaceRoot: string,
  options: ProjectMcpRuntimeOptions = {}
): Promise<McpToolRuntime> {
  try {
    const state = await loadMcpConfigState(workspaceRoot, {
      homeDirectory: options.homeDirectory,
      trustedProject: options.trusted !== false
    });
    return new ProjectMcpRuntime(workspaceRoot, state, undefined, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new ProjectMcpRuntime(workspaceRoot, undefined, message, options);
  }
}

export class ProjectMcpRuntime implements McpToolRuntime {
  private readonly servers = new Map<string, McpServerRuntime>();
  private readonly toolsByExposedName = new Map<string, McpToolMetadata>();
  private readonly outputDirectory: string;
  private readonly homeDirectory: string;
  private toolSchemasCache: ChatCompletionTool[] = [];
  private initializationRunCounter = 0;
  private closed = false;
  private trustedProject: boolean;
  private elicitationHandler?: (
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<McpElicitationResponse>;
  private elicitationCompleteHandler?: (event: McpElicitationCompleteEvent) => void;

  constructor(
    private readonly workspaceRoot: string,
    state?: McpConfigState,
    configurationError?: string,
    options: ProjectMcpRuntimeOptions = {}
  ) {
    this.trustedProject = options.trusted !== false;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.outputDirectory = options.outputDirectory ?? path.join(workspaceRoot, ".alyce", "mcp-output");
    if (state) {
      this.applyConfigState(state, this.trustedProject);
      return;
    }

    this.setConfigurationError(configurationError ?? "Unknown MCP configuration error.");
  }

  setInteractionHandlers(handlers: {
    requestElicitation?: (
      request: McpElicitationRequest,
      options?: { signal?: AbortSignal; timeoutMs?: number }
    ) => Promise<McpElicitationResponse>;
    onElicitationComplete?: (event: McpElicitationCompleteEvent) => void;
  }) {
    this.elicitationHandler = handlers.requestElicitation;
    this.elicitationCompleteHandler = handlers.onElicitationComplete;
  }

  async getToolSchemas(options: {
    abortSignal?: AbortSignal;
    initialize?: boolean;
  } = {}): Promise<ChatCompletionTool[]> {
    throwIfAborted(options.abortSignal);
    if (options.initialize) {
      await this.ensureInitialized(options);
    }
    throwIfAborted(options.abortSignal);
    return this.toolSchemasCache;
  }

  canExecuteTool(toolName: string): boolean {
    return this.toolsByExposedName.has(toolName);
  }

  async executeNamedToolCall(
    serverName: string,
    toolName: string,
    args: JsonRecord,
    options: {
      requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ): Promise<unknown> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    throwIfAborted(options.abortSignal);
    const server = this.servers.get(normalizeRequestedServerName(serverName));
    if (!server) {
      return {
        status: "error",
        error: "unknown_mcp_server",
        server: serverName,
        tool: toolName,
        message: `Unknown MCP server: ${serverName}`
      };
    }

    const tool = server.toolsByOriginalName.get(toolName);
    if (!tool) {
      return {
        status: "error",
        error: "unknown_mcp_tool",
        server: serverName,
        tool: toolName,
        message: `Unknown MCP tool '${toolName}' on server '${serverName}'.`
      };
    }

    return this.executeResolvedToolCall(server, tool, args, options);
  }

  async executeToolCall(
    toolName: string,
    args: JsonRecord,
    options: {
      requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ): Promise<unknown> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    throwIfAborted(options.abortSignal);
    const tool = this.toolsByExposedName.get(toolName);
    if (!tool) {
      return {
        status: "error",
        error: "unknown_mcp_tool",
        message: `Unknown MCP tool: ${toolName}`
      };
    }

    const server = this.servers.get(tool.serverName);
    if (!server) {
      return {
        status: "error",
        error: "unknown_mcp_server",
        server: tool.serverName,
        tool: tool.originalName,
        message: `Unknown MCP server: ${tool.serverName}`
      };
    }

    return this.executeResolvedToolCall(server, tool, args, options);
  }

  private async executeResolvedToolCall(
    server: McpServerRuntime,
    tool: McpToolMetadata,
    args: JsonRecord,
    options: {
      requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ): Promise<unknown> {
    if (!server?.client || server.status !== "connected") {
      return {
        status: "error",
        error: "mcp_server_unavailable",
        server: tool.serverName,
        tool: tool.originalName,
        message: server?.error ?? `MCP server is unavailable: ${tool.serverName}`
      };
    }

    const approvalAction = resolveMcpToolApprovalAction(server.config, tool.originalName);
    if (approvalAction === "deny") {
      throw new Error(
        `MCP tool '${tool.serverName}.${tool.originalName}' is denied by MCP approval policy.`
      );
    }

    if (approvalAction === "ask") {
      const approved = await options.requestApproval(
        buildMcpToolApprovalRequest(server, tool, args)
      );

      if (!approved) {
        return {
          status: "rejected",
          server: tool.serverName,
          tool: tool.originalName,
          message: "User rejected the MCP tool request."
        };
      }
    }

    throwIfAborted(options.abortSignal);

    const timeoutMs = resolveMcpTimeout(server, "call", options.timeoutMs);
    const result = await withTimeout(
      trackServerOperation(
        server,
        `callTool ${tool.originalName}`,
        timeoutMs,
        () => server.client!.callTool(
          {
            name: tool.originalName,
            arguments: args
          },
          undefined,
          {
            signal: options.abortSignal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs
          }
        )
      ),
      timeoutMs,
      `MCP tool '${tool.serverName}.${tool.originalName}' timed out after ${timeoutMs} ms.`,
      { abortSignal: options.abortSignal }
    );

    throwIfAborted(options.abortSignal);

    return normalizeMcpToolResult(tool, result);
  }

  async getStatus(options: {
    abortSignal?: AbortSignal;
    initialize?: boolean;
  } = {}): Promise<McpStatusResult> {
    throwIfAborted(options.abortSignal);
    if (options.initialize) {
      await this.ensureInitialized(options);
    }
    throwIfAborted(options.abortSignal);

    const servers = [...this.servers.values()]
      .map((server) => this.toServerStatus(server))
      .sort((left, right) => left.name.localeCompare(right.name));

    const requiredFailures = servers.filter((server) =>
      server.required &&
      (server.status === "failed" || server.status === "auth_required")
    );

    return {
      servers,
      ...(requiredFailures.length > 0
        ? {
            message: `Required MCP servers failed: ${requiredFailures.map((server) => server.name).join(", ")}`
          }
        : {})
    };
  }

  async listTools(options: {
    serverName?: string;
    abortSignal?: AbortSignal;
  } = {}): Promise<McpListToolsResult> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    throwIfAborted(options.abortSignal);

    const servers = this.getSelectedServers(options.serverName);
    const results = servers.map((server) => this.listServerToolMetadata(server));
    return {
      servers: results,
      toolCount: results.reduce((total, result) => total + result.tools.length, 0)
    };
  }

  async listResources(options: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<McpListResourcesResult> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    throwIfAborted(options.abortSignal);

    const servers = this.getSelectedServers(options.serverName);
    const results = await Promise.all(servers.map((server) =>
      this.listServerResources(server, options)
    ));

    return {
      servers: results,
      resourceCount: results.reduce((total, result) => total + result.resources.length, 0)
    };
  }

  async listPrompts(options: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<McpListPromptsResult> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    throwIfAborted(options.abortSignal);

    const servers = this.getSelectedServers(options.serverName);
    const results = await Promise.all(servers.map((server) =>
      this.listServerPrompts(server, options)
    ));

    return {
      servers: results,
      promptCount: results.reduce((total, result) => total + result.prompts.length, 0)
    };
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string> = {},
    options: {
      maxTextChars?: number;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ): Promise<McpPromptResult> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    const server = this.servers.get(normalizeRequestedServerName(serverName));
    if (!server) {
      return {
        status: "not_found",
        server: serverName,
        name: promptName,
        messages: [],
        error: `Unknown MCP server: ${serverName}`
      };
    }

    if (server.status === "disabled") {
      return {
        status: "disabled",
        server: server.name,
        name: promptName,
        messages: [],
        error: `MCP server '${server.name}' is disabled.`
      };
    }

    if (!server.client || server.status !== "connected" || server.error) {
      return {
        status: "error",
        server: server.name,
        name: promptName,
        messages: [],
        error: server.error ?? `MCP server is unavailable: ${server.name}`
      };
    }

    if (!server.client.getServerCapabilities()?.prompts) {
      return {
        status: "unsupported",
        server: server.name,
        name: promptName,
        messages: [],
        error: `MCP server '${server.name}' does not expose prompts.`
      };
    }

    try {
      throwIfAborted(options.abortSignal);
      const timeoutMs = resolveMcpTimeout(server, "read", options.timeoutMs);
      const result = await withTimeout(
        trackServerOperation(
          server,
          `getPrompt ${promptName}`,
          timeoutMs,
          () => server.client!.getPrompt(
            {
              name: promptName,
              ...(Object.keys(args).length > 0 ? { arguments: args } : {})
            },
            {
              signal: options.abortSignal,
              timeout: timeoutMs,
              maxTotalTimeout: timeoutMs
            }
          )
        ),
        timeoutMs,
        `MCP prompt '${server.name}: ${promptName}' timed out after ${timeoutMs} ms.`,
        { abortSignal: options.abortSignal }
      );
      throwIfAborted(options.abortSignal);

      return {
        status: "completed",
        server: server.name,
        name: promptName,
        ...(result.description ? { description: result.description } : {}),
        messages: await this.normalizePromptMessages(
          server.name,
          promptName,
          result.messages,
          options.maxTextChars ?? MCP_PROMPT_TEXT_MAX_CHARS
        )
      };
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw error;
      }

      return {
        status: "error",
        server: server.name,
        name: promptName,
        messages: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listResourceTemplates(options: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<McpListResourceTemplatesResult> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    throwIfAborted(options.abortSignal);

    const servers = this.getSelectedServers(options.serverName);
    const results = await Promise.all(servers.map((server) =>
      this.listServerResourceTemplates(server, options)
    ));

    return {
      servers: results,
      resourceTemplateCount: results.reduce(
        (total, result) => total + result.resourceTemplates.length,
        0
      )
    };
  }

  async readResource(
    serverName: string,
    uri: string,
    options: {
      maxTextChars?: number;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ): Promise<McpReadResourceResult> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized(options);
    const server = this.servers.get(normalizeRequestedServerName(serverName));
    if (!server) {
      return {
        status: "not_found",
        server: serverName,
        uri,
        contents: [],
        error: `Unknown MCP server: ${serverName}`
      };
    }

    if (server.status === "disabled") {
      return {
        status: "disabled",
        server: server.name,
        uri,
        contents: [],
        error: `MCP server '${server.name}' is disabled.`
      };
    }

    if (!server.client || server.status !== "connected" || server.error) {
      return {
        status: "error",
        server: server.name,
        uri,
        contents: [],
        error: server.error ?? `MCP server is unavailable: ${server.name}`
      };
    }

    if (!server.client.getServerCapabilities()?.resources) {
      return {
        status: "unsupported",
        server: server.name,
        uri,
        contents: [],
        error: `MCP server '${server.name}' does not expose resources.`
      };
    }

    try {
      throwIfAborted(options.abortSignal);
      const timeoutMs = resolveMcpTimeout(server, "read", options.timeoutMs);
      const result = await withTimeout(
        trackServerOperation(
          server,
          `readResource ${uri}`,
          timeoutMs,
          () => server.client!.readResource(
            { uri },
            {
              signal: options.abortSignal,
              timeout: timeoutMs,
              maxTotalTimeout: timeoutMs
            }
          )
        ),
        timeoutMs,
        `MCP resource read '${server.name}: ${uri}' timed out after ${timeoutMs} ms.`,
        { abortSignal: options.abortSignal }
      );
      throwIfAborted(options.abortSignal);

      return {
        status: "completed",
        server: server.name,
        uri,
        contents: await this.normalizeResourceContents(
          server.name,
          result.contents,
          options.maxTextChars ?? 20_000
        )
      };
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw error;
      }

      return {
        status: "error",
        server: server.name,
        uri,
        contents: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async loginServer(
    serverName: string,
    options: {
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      onAuthorizationUrl?: (details: {
        server: string;
        authorizationUrl: string;
        redirectUrl: string;
      }) => void;
    } = {}
  ): Promise<McpLoginResult> {
    throwIfAborted(options.abortSignal);
    await this.ensureInitialized({ abortSignal: options.abortSignal });
    const server = this.servers.get(normalizeRequestedServerName(serverName));
    if (!server) {
      return {
        status: "not_found",
        server: serverName,
        message: `Unknown MCP server: ${serverName}`
      };
    }

    if (server.status === "disabled") {
      return {
        status: "disabled",
        server: server.name,
        message: `MCP server '${server.name}' is disabled.`
      };
    }

    if (server.config.type === "stdio") {
      return {
        status: "unsupported",
        server: server.name,
        message: `MCP server '${server.name}' uses stdio and does not support /mcp login.`
      };
    }

    const callbackServer = await createMcpOAuthCallbackServer();
    let authorizationUrl: string | undefined;

    try {
      const authProvider = createPersistentMcpOAuthProvider({
        serverName: server.name,
        serverConfig: server.config,
        redirectUrl: callbackServer.redirectUrl,
        onRedirect: (url) => {
          authorizationUrl = url.toString();
          options.onAuthorizationUrl?.({
            server: server.name,
            authorizationUrl,
            redirectUrl: callbackServer.redirectUrl
          });
        }
      });

      let transport = createTransport(
        server.name,
        server.config,
        this.workspaceRoot,
        authProvider
      ) as SSEClientTransport | StreamableHTTPClientTransport;
      let client = this.createProtocolClient(server.name, 0);
      try {
        const timeoutMs = options.timeoutMs ?? resolveMcpTimeout(server, "connect");
        await withTimeout(
          trackServerOperation(
            server,
            "login/connect",
            timeoutMs,
            () => client.connect(transport)
          ),
          timeoutMs,
          `MCP server '${server.name}' did not start login in time.`,
          { abortSignal: options.abortSignal }
        );
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) {
          throw error;
        }

        const authorizationCode = await callbackServer.waitForAuthorizationCode({
          signal: options.abortSignal,
          timeoutMs: options.timeoutMs ?? MCP_LOGIN_TIMEOUT_MS
        });
        await transport.finishAuth(authorizationCode);
        await closeTransportWithTimeout(server, transport);
        transport = createTransport(
          server.name,
          server.config,
          this.workspaceRoot,
          authProvider
        ) as SSEClientTransport | StreamableHTTPClientTransport;
        client = this.createProtocolClient(server.name, 0);
        const timeoutMs = options.timeoutMs ?? resolveMcpTimeout(server, "connect");
        await withTimeout(
          trackServerOperation(
            server,
            "login/reconnect",
            timeoutMs,
            () => client.connect(transport)
          ),
          timeoutMs,
          `MCP server '${server.name}' did not reconnect after login in time.`,
          { abortSignal: options.abortSignal }
        );
      } finally {
        await closeTransportWithTimeout(server, transport);
      }

      await this.refreshServerConnection(server.name, { abortSignal: options.abortSignal });
      return {
        status: "completed",
        server: server.name,
        message: authorizationUrl
          ? `MCP server '${server.name}' login completed and the connection was refreshed.`
          : `MCP server '${server.name}' is already authorized and the connection was refreshed.`,
        ...(authorizationUrl ? { authorizationUrl } : {}),
        redirectUrl: callbackServer.redirectUrl
      };
    } catch (error) {
      return {
        status: "error",
        server: server.name,
        message: error instanceof Error ? error.message : String(error),
        ...(authorizationUrl ? { authorizationUrl } : {}),
        redirectUrl: callbackServer.redirectUrl
      };
    } finally {
      await callbackServer.close().catch(() => undefined);
    }
  }

  async reloadConfig(): Promise<void> {
    try {
      const state = await loadMcpConfigState(this.workspaceRoot, this.getConfigLoadOptions());
      await this.replaceConfigState(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.replaceConfigState(undefined, message);
      throw error;
    }
  }

  async setProjectTrusted(trusted: boolean): Promise<void> {
    this.trustedProject = trusted;
    await this.reloadConfig();
  }

  async addServer(
    name: string,
    config: McpServerConfig,
    options: { scope?: McpConfigScope } = {}
  ): Promise<McpConfigMutationResult> {
    const result = await writeMcpServerConfig(
      this.workspaceRoot,
      options.scope ?? "project",
      name,
      config,
      this.getConfigLoadOptions()
    );
    await this.replaceConfigState(result.state);
    return result;
  }

  async removeServer(
    name: string,
    options: { scope?: McpConfigScope } = {}
  ): Promise<McpConfigMutationResult> {
    const result = await removeMcpServerConfig(
      this.workspaceRoot,
      options.scope ?? "project",
      name,
      this.getConfigLoadOptions()
    );
    await this.replaceConfigState(result.state);
    return result;
  }

  async setServerEnabled(
    name: string,
    enabled: boolean,
    options: { scope?: McpConfigScope } = {}
  ): Promise<McpConfigMutationResult> {
    const result = await setScopedMcpServerEnabled(
      this.workspaceRoot,
      options.scope ?? "project",
      name,
      enabled,
      this.getConfigLoadOptions()
    );
    await this.replaceConfigState(result.state);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.toolsByExposedName.clear();
    this.toolSchemasCache = [];
    await Promise.allSettled([...this.servers.values()].map(async (server) => {
      this.invalidateInitializationRun(server);
      clearReconnectTimer(server);
      if (server.initializing) {
        server.error = "MCP runtime closed during initialization.";
        server.recentError = server.error;
        server.lastErrorAt = new Date().toISOString();
        server.status = "failed";
      } else if (server.status !== "disabled") {
        server.status = "not_initialized";
      }
      await closeServerTransport(server);
      server.client = undefined;
      server.transport = undefined;
      setServerTools(server, []);
      server.initializing = undefined;
    }));
  }

  private async replaceConfigState(
    state?: McpConfigState,
    configurationError?: string
  ): Promise<void> {
    const previousServers = [...this.servers.values()];
    this.toolsByExposedName.clear();
    this.toolSchemasCache = [];
    this.servers.clear();

    await Promise.allSettled(previousServers.map(async (server) => {
      this.invalidateInitializationRun(server);
      clearReconnectTimer(server);
      await closeServerTransport(server);
    }));

    if (state) {
      this.applyConfigState(state, this.trustedProject);
      return;
    }

    this.setConfigurationError(configurationError ?? "Unknown MCP configuration error.");
  }

  private applyConfigState(state: McpConfigState, trustedProject = true) {
    for (const [name, serverConfig] of Object.entries(state.effective.mcpServers)) {
      const scope = state.sources[name] ?? "project";
      const disabledByTrust = !trustedProject && scope !== "user";
      const effectiveConfig = disabledByTrust
        ? {
            ...serverConfig,
            enabled: false
          }
        : serverConfig;
      this.servers.set(name, {
        name,
        scope,
        config: effectiveConfig,
        status: isServerEnabled(effectiveConfig) ? "not_initialized" : "disabled",
        tools: [],
        toolsByOriginalName: new Map(),
        ...(disabledByTrust
          ? {
              error: "Project MCP servers are disabled until this workspace is trusted.",
              recentError: "Project MCP servers are disabled until this workspace is trusted."
            }
          : {}),
        reconnectAttempt: 0,
        directToolCount: 0,
        hiddenToolCount: 0,
        toolExposure: "direct"
      });
    }
  }

  private getConfigLoadOptions() {
    return {
      homeDirectory: this.homeDirectory,
      trustedProject: this.trustedProject
    };
  }

  private setConfigurationError(message: string) {
    const configErrorServer: McpServerRuntime = {
      name: "configuration",
      scope: "project",
      config: {
        type: "stdio",
        command: "",
        enabled: false
      },
      status: "failed",
      tools: [],
      toolsByOriginalName: new Map(),
      error: message,
      recentError: message,
      lastErrorAt: new Date().toISOString(),
      reconnectAttempt: 0,
      directToolCount: 0,
      hiddenToolCount: 0,
      toolExposure: "direct"
    };
    this.servers.set(configErrorServer.name, configErrorServer);
  }

  private toServerStatus(server: McpServerRuntime): McpServerStatus {
    const capabilities = server.client?.getServerCapabilities();
    return {
      name: server.name,
      scope: server.scope,
      enabled: isServerEnabled(server.config),
      required: server.config.required === true,
      status: server.status,
      transport: server.config.type,
      endpoint: formatEndpoint(server.config),
      ...(server.error ? { error: server.error } : {}),
      ...(server.recentError ? { recentError: server.recentError } : {}),
      ...(server.lastOperation ? { lastOperation: server.lastOperation } : {}),
      ...(server.lastOperationStartedAt ? { lastOperationStartedAt: server.lastOperationStartedAt } : {}),
      ...(server.lastOperationCompletedAt ? { lastOperationCompletedAt: server.lastOperationCompletedAt } : {}),
      ...(server.lastConnectedAt ? { lastConnectedAt: server.lastConnectedAt } : {}),
      ...(server.lastErrorAt ? { lastErrorAt: server.lastErrorAt } : {}),
      ...(server.lastTimeoutMs ? { lastTimeoutMs: server.lastTimeoutMs } : {}),
      ...(server.nextReconnectAt ? { nextReconnectAt: server.nextReconnectAt } : {}),
      capabilities: {
        tools: Boolean(capabilities?.tools),
        resources: Boolean(capabilities?.resources),
        prompts: Boolean(capabilities?.prompts)
      },
      toolCount: server.tools.length,
      directToolCount: server.directToolCount,
      hiddenToolCount: server.hiddenToolCount,
      toolExposure: server.toolExposure
    };
  }

  private async ensureInitialized(options: { abortSignal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.abortSignal);
    const servers = [...this.servers.values()].filter((server) => isServerEnabled(server.config));
    await Promise.all(servers.map((server) => this.ensureServerInitialized(server, options)));
    throwIfAborted(options.abortSignal);
    this.rebuildToolIndex();
  }

  private async ensureServerInitialized(
    server: McpServerRuntime,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<void> {
    throwIfAborted(options.abortSignal);
    if (!isServerEnabled(server.config) || this.closed) {
      return;
    }

    if (server.status === "connected" && server.client) {
      return;
    }

    if (server.initializing) {
      await withAbort(server.initializing, options.abortSignal);
      return;
    }

    if (server.reconnectTimer) {
      clearReconnectTimer(server);
    }

    const reason: InitializationReason = server.status === "reconnecting"
      ? "reconnect"
      : "initial";
    const runId = this.nextInitializationRunId(server);
    server.status = reason === "reconnect" ? "reconnecting" : "connecting";
    server.initializing = this.initializeServer(server, runId, reason, options);
    await withAbort(server.initializing, options.abortSignal);
  }

  private nextInitializationRunId(server: McpServerRuntime): number {
    this.initializationRunCounter += 1;
    server.initializationRunId = this.initializationRunCounter;
    return server.initializationRunId;
  }

  private invalidateInitializationRun(server: McpServerRuntime) {
    this.initializationRunCounter += 1;
    server.initializationRunId = this.initializationRunCounter;
  }

  private createProtocolClient(
    serverName: string,
    runId: number,
    abortSignal?: AbortSignal
  ) {
    const client = new Client({
      name: "alyce",
      version: "0.1.10"
    }, {
      capabilities: {
        elicitation: {
          form: {},
          url: {}
        }
      },
      listChanged: {
        tools: {
          autoRefresh: true,
          onChanged: (error, tools) => {
            this.handleToolListChanged(serverName, runId, error ?? undefined, tools ?? []);
          }
        },
        resources: {
          autoRefresh: true,
          onChanged: (error) => {
            this.handleListChanged(serverName, runId, "resources", error ?? undefined);
          }
        },
        prompts: {
          autoRefresh: true,
          onChanged: (error) => {
            this.handleListChanged(serverName, runId, "prompts", error ?? undefined);
          }
        }
      }
    });

    client.setRequestHandler(ElicitRequestSchema, async (request) =>
      await this.handleElicitationRequest(serverName, request.params, { abortSignal })
    );
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, (notification) => {
      this.elicitationCompleteHandler?.({
        serverName,
        elicitationId: notification.params.elicitationId
      });
    });

    return client;
  }

  private async refreshServerConnection(
    serverName: string,
    options: { abortSignal?: AbortSignal } = {}
  ) {
    const server = this.servers.get(normalizeRequestedServerName(serverName));
    if (!server || !isServerEnabled(server.config) || this.closed) {
      return;
    }

    this.invalidateInitializationRun(server);
    clearReconnectTimer(server);
    await closeServerTransport(server);
    server.status = "not_initialized";
    server.error = undefined;
    server.recentError = undefined;
    server.lastOperation = undefined;
    server.lastTimeoutMs = undefined;
    await this.ensureServerInitialized(server, options);
  }

  private async handleElicitationRequest(
    serverName: string,
    params: ElicitRequestParams,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<ElicitResult> {
    if (!this.elicitationHandler) {
      return { action: "decline" };
    }

    try {
      const request = normalizeElicitationRequest(serverName, params);
      const response = await withTimeout(
        this.elicitationHandler(request, {
          signal: options.abortSignal,
          timeoutMs: MCP_LOGIN_TIMEOUT_MS
        }),
        MCP_LOGIN_TIMEOUT_MS,
        `MCP elicitation from '${serverName}' timed out after ${MCP_LOGIN_TIMEOUT_MS} ms.`,
        { abortSignal: options.abortSignal }
      );
      return normalizeElicitationResponse(response);
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw error;
      }

      return { action: "cancel" };
    }
  }

  private async initializeServer(
    server: McpServerRuntime,
    runId: number,
    reason: InitializationReason,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<void> {
    let transport: Transport | undefined;
    const errorChunks: string[] = [];

    try {
      const client = this.createProtocolClient(server.name, runId, options.abortSignal);
      transport = createTransport(server.name, server.config, this.workspaceRoot);
      const activeTransport = transport;

      server.transport = activeTransport;
      activeTransport.onerror = (error) => {
        appendErrorChunk(errorChunks, error.message);
      };
      activeTransport.onclose = () => {
        void this.handleTransportClosed(server.name, runId);
      };
      if (activeTransport instanceof StdioClientTransport) {
        activeTransport.stderr?.on("data", (chunk: Buffer | string) => {
          appendErrorChunk(errorChunks, Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
        });
      }

      const startupTimeoutMs = resolveMcpTimeout(server, "connect");
      await withTimeout(
        trackServerOperation(
          server,
          reason === "reconnect" ? "reconnect" : "connect",
          startupTimeoutMs,
          () => client.connect(activeTransport)
        ),
        startupTimeoutMs,
        `MCP server '${server.name}' did not start in time.`,
        {
          abortSignal: options.abortSignal,
          onTimeoutOrAbort: () => {
            releaseInitializingServer(server, runId);
            closeTransportQuietly(activeTransport);
          }
        }
      );

      if (!isCurrentInitializationRun(server, runId)) {
        await closeTransportWithTimeout(server, transport);
        return;
      }

      server.client = client;
      server.transport = transport;
      const tools = await listServerTools(server, client, {
        abortSignal: options.abortSignal,
        timeoutMs: resolveMcpTimeout(server, "list"),
        onTimeoutOrAbort: () => {
          releaseInitializingServer(server, runId);
          closeTransportQuietly(activeTransport);
        }
      });

      if (!isCurrentInitializationRun(server, runId)) {
        await closeTransportWithTimeout(server, transport);
        return;
      }

      setServerTools(server, tools);
      server.status = "connected";
      server.error = undefined;
      server.recentError = undefined;
      server.lastConnectedAt = new Date().toISOString();
      server.reconnectAttempt = 0;
      server.nextReconnectAt = undefined;
      this.rebuildToolIndex();
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        if (isCurrentInitializationRun(server, runId)) {
          setServerTools(server, []);
          server.status = "failed";
          this.rebuildToolIndex();
        }
        await closeTransportWithTimeout(server, transport);
        if (isCurrentInitializationRun(server, runId)) {
          server.client = undefined;
          server.transport = undefined;
        }
        throw error;
      }

      const message = buildRuntimeErrorMessage(error, errorChunks) ||
        (error instanceof UnauthorizedError
          ? "MCP server requires authorization."
          : "Unknown MCP runtime error.");
      if (isCurrentInitializationRun(server, runId)) {
        server.error = message;
        server.recentError = message;
        server.lastErrorAt = new Date().toISOString();
        setServerTools(server, []);
        server.status = error instanceof UnauthorizedError
          ? "auth_required"
          : classifyErrorStatus(message);
        this.rebuildToolIndex();
      }
      await closeTransportWithTimeout(server, transport);
      if (isCurrentInitializationRun(server, runId)) {
        server.client = undefined;
        server.transport = undefined;
      }
    } finally {
      releaseInitializingServer(server, runId);
    }
  }

  private async handleTransportClosed(serverName: string, runId: number) {
    const server = this.servers.get(serverName);
    if (!server || !isCurrentInitializationRun(server, runId) || server.suppressCloseHandling) {
      return;
    }

    const wasConnected = server.status === "connected";
    server.client = undefined;
    server.transport = undefined;
    setServerTools(server, []);
    this.rebuildToolIndex();

    if (!wasConnected || this.closed || !isServerEnabled(server.config)) {
      return;
    }

    const errorMessage = server.error ?? "MCP connection closed.";
    server.error = errorMessage;
    server.recentError = errorMessage;
    server.lastErrorAt = new Date().toISOString();
    server.status = "reconnecting";
    this.scheduleReconnect(server);
  }

  private handleToolListChanged(
    serverName: string,
    runId: number,
    error: Error | undefined,
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>
  ) {
    const server = this.servers.get(serverName);
    if (!server || !isCurrentInitializationRun(server, runId)) {
      return;
    }

    if (error) {
      this.recordServerError(server, `tools/list_changed: ${error.message}`);
      return;
    }

    setServerTools(server, mapListedTools(server.name, tools));
    server.lastOperation = "tools/list_changed";
    server.lastOperationCompletedAt = new Date().toISOString();
    server.recentError = undefined;
    this.rebuildToolIndex();
  }

  private handleListChanged(
    serverName: string,
    runId: number,
    kind: "resources" | "prompts",
    error: Error | undefined
  ) {
    const server = this.servers.get(serverName);
    if (!server || !isCurrentInitializationRun(server, runId)) {
      return;
    }

    if (error) {
      this.recordServerError(server, `${kind}/list_changed: ${error.message}`);
      return;
    }

    server.lastOperation = `${kind}/list_changed`;
    server.lastOperationCompletedAt = new Date().toISOString();
    server.recentError = undefined;
  }

  private scheduleReconnect(server: McpServerRuntime) {
    if (this.closed || server.reconnectTimer || !isServerEnabled(server.config)) {
      return;
    }

    server.reconnectAttempt += 1;
    const delayMs = Math.min(
      MCP_RECONNECT_MAX_DELAY_MS,
      MCP_RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, server.reconnectAttempt - 1))
    );
    server.status = "reconnecting";
    server.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    server.reconnectTimer = setTimeout(() => {
      server.reconnectTimer = undefined;
      server.nextReconnectAt = undefined;
      if (this.closed || !isServerEnabled(server.config) || server.initializing) {
        return;
      }

      const runId = this.nextInitializationRunId(server);
      server.status = "reconnecting";
      server.initializing = this.initializeServer(server, runId, "reconnect");
      void server.initializing.catch(() => undefined);
    }, delayMs);
    server.reconnectTimer.unref?.();
  }

  private recordServerError(server: McpServerRuntime, message: string) {
    server.recentError = message;
    server.lastErrorAt = new Date().toISOString();
  }

  private getSelectedServers(serverName: string | undefined): McpServerRuntime[] {
    if (!serverName) {
      return [...this.servers.values()];
    }

    const server = this.servers.get(normalizeRequestedServerName(serverName));
    if (server) {
      return [server];
    }

    return [{
      name: serverName,
      scope: "project",
      config: {
        type: "stdio",
        command: ""
      },
      status: "failed",
      tools: [],
      toolsByOriginalName: new Map(),
      error: `Unknown MCP server: ${serverName}`,
      recentError: `Unknown MCP server: ${serverName}`,
      reconnectAttempt: 0,
      directToolCount: 0,
      hiddenToolCount: 0,
      toolExposure: "direct"
    }];
  }

  private listServerToolMetadata(server: McpServerRuntime): McpServerToolList {
    if (server.status === "disabled") {
      return {
        server: server.name,
        status: "disabled",
        tools: [],
        error: `MCP server '${server.name}' is disabled.`
      };
    }

    if (!server.client || server.status !== "connected") {
      return {
        server: server.name,
        status: server.error?.startsWith("Unknown MCP server") ? "not_found" : "error",
        tools: [],
        error: server.error ?? `MCP server is unavailable: ${server.name}`
      };
    }

    return {
      server: server.name,
      status: "completed",
      tools: server.tools.map((tool) => ({
        server: tool.serverName,
        name: tool.originalName,
        exposedName: tool.exposedName,
        description: tool.description
      }))
    };
  }

  private async listServerResources(
    server: McpServerRuntime,
    options: McpRuntimeOperationOptions
  ): Promise<McpServerResourceList> {
    if (server.status === "disabled") {
      return {
        server: server.name,
        status: "disabled",
        resources: [],
        error: `MCP server '${server.name}' is disabled.`
      };
    }

    if (!server.client || server.status !== "connected") {
      return {
        server: server.name,
        status: server.error?.startsWith("Unknown MCP server") ? "not_found" : "error",
        resources: [],
        error: server.error ?? `MCP server is unavailable: ${server.name}`
      };
    }

    if (!server.client.getServerCapabilities()?.resources) {
      return {
        server: server.name,
        status: "unsupported",
        resources: [],
        error: `MCP server '${server.name}' does not expose resources.`
      };
    }

    try {
      throwIfAborted(options.abortSignal);
      const timeoutMs = resolveMcpTimeout(server, "list", options.timeoutMs);
      const listed = await withTimeout(
        trackServerOperation(
          server,
          "listResources",
          timeoutMs,
          () => server.client!.listResources(undefined, {
            signal: options.abortSignal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs
          })
        ),
        timeoutMs,
        `MCP resources/list '${server.name}' timed out after ${timeoutMs} ms.`,
        { abortSignal: options.abortSignal }
      );
      throwIfAborted(options.abortSignal);

      return {
        server: server.name,
        status: "completed",
        resources: listed.resources.map((resource) => normalizeResourceSummary(server.name, resource)),
        ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {})
      };
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw error;
      }

      return {
        server: server.name,
        status: "error",
        resources: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async listServerPrompts(
    server: McpServerRuntime,
    options: McpRuntimeOperationOptions
  ): Promise<McpServerPromptList> {
    if (server.status === "disabled") {
      return {
        server: server.name,
        status: "disabled",
        prompts: [],
        error: `MCP server '${server.name}' is disabled.`
      };
    }

    if (!server.client || server.status !== "connected") {
      return {
        server: server.name,
        status: server.error?.startsWith("Unknown MCP server") ? "not_found" : "error",
        prompts: [],
        error: server.error ?? `MCP server is unavailable: ${server.name}`
      };
    }

    if (!server.client.getServerCapabilities()?.prompts) {
      return {
        server: server.name,
        status: "unsupported",
        prompts: [],
        error: `MCP server '${server.name}' does not expose prompts.`
      };
    }

    try {
      throwIfAborted(options.abortSignal);
      const timeoutMs = resolveMcpTimeout(server, "list", options.timeoutMs);
      const listed = await withTimeout(
        trackServerOperation(
          server,
          "listPrompts",
          timeoutMs,
          () => server.client!.listPrompts(undefined, {
            signal: options.abortSignal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs
          })
        ),
        timeoutMs,
        `MCP prompts/list '${server.name}' timed out after ${timeoutMs} ms.`,
        { abortSignal: options.abortSignal }
      );
      throwIfAborted(options.abortSignal);

      return {
        server: server.name,
        status: "completed",
        prompts: listed.prompts.map((prompt) => normalizePromptSummary(server.name, prompt)),
        ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {})
      };
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw error;
      }

      return {
        server: server.name,
        status: "error",
        prompts: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async listServerResourceTemplates(
    server: McpServerRuntime,
    options: McpRuntimeOperationOptions
  ): Promise<McpServerResourceTemplateList> {
    if (server.status === "disabled") {
      return {
        server: server.name,
        status: "disabled",
        resourceTemplates: [],
        error: `MCP server '${server.name}' is disabled.`
      };
    }

    if (!server.client || server.status !== "connected") {
      return {
        server: server.name,
        status: server.error?.startsWith("Unknown MCP server") ? "not_found" : "error",
        resourceTemplates: [],
        error: server.error ?? `MCP server is unavailable: ${server.name}`
      };
    }

    if (!server.client.getServerCapabilities()?.resources) {
      return {
        server: server.name,
        status: "unsupported",
        resourceTemplates: [],
        error: `MCP server '${server.name}' does not expose resource templates.`
      };
    }

    try {
      throwIfAborted(options.abortSignal);
      const timeoutMs = resolveMcpTimeout(server, "list", options.timeoutMs);
      const listed = await withTimeout(
        trackServerOperation(
          server,
          "listResourceTemplates",
          timeoutMs,
          () => server.client!.listResourceTemplates(undefined, {
            signal: options.abortSignal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs
          })
        ),
        timeoutMs,
        `MCP resource templates/list '${server.name}' timed out after ${timeoutMs} ms.`,
        { abortSignal: options.abortSignal }
      );
      throwIfAborted(options.abortSignal);

      return {
        server: server.name,
        status: "completed",
        resourceTemplates: listed.resourceTemplates.map((template) =>
          normalizeResourceTemplateSummary(server.name, template)
        ),
        ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {})
      };
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw error;
      }

      return {
        server: server.name,
        status: "error",
        resourceTemplates: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async normalizeResourceContents(
    serverName: string,
    contents: unknown[],
    maxTextChars: number
  ): Promise<McpReadResourceContent[]> {
    const normalized: McpReadResourceContent[] = [];
    let blobIndex = 0;

    for (const content of contents) {
      if (!content || typeof content !== "object") {
        continue;
      }

      const record = content as Record<string, unknown>;
      const uri = typeof record.uri === "string" ? record.uri : "";
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
      if (typeof record.text === "string") {
        normalized.push({
          type: "text",
          uri,
          ...(mimeType ? { mimeType } : {}),
          text: truncate(record.text, maxTextChars),
          length: record.text.length,
          truncated: record.text.length > maxTextChars
        });
        continue;
      }

      if (typeof record.blob === "string") {
        const bytes = Buffer.from(record.blob, "base64");
        const outputPath = await this.writeBlobResource(serverName, uri, mimeType, blobIndex, bytes);
        blobIndex += 1;
        normalized.push({
          type: "blob",
          uri,
          ...(mimeType ? { mimeType } : {}),
          outputPath,
          sizeBytes: bytes.length,
          base64Length: record.blob.length
        });
      }
    }

    return normalized;
  }

  private async normalizePromptMessages(
    serverName: string,
    promptName: string,
    messages: Array<{
      role: "user" | "assistant";
      content: unknown;
    }>,
    maxTextChars: number
  ): Promise<McpPromptMessage[]> {
    const normalized: McpPromptMessage[] = [];
    let blobIndex = 0;

    for (const message of messages) {
      const contents = Array.isArray(message.content)
        ? message.content
        : [message.content];
      const normalizedContents: McpPromptContent[] = [];

      for (const content of contents) {
        if (!content || typeof content !== "object") {
          continue;
        }

        const record = content as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          normalizedContents.push({
            type: "text",
            text: truncate(record.text, maxTextChars),
            length: record.text.length,
            truncated: record.text.length > maxTextChars
          });
          continue;
        }

        if ((record.type === "image" || record.type === "audio") &&
          typeof record.mimeType === "string" &&
          typeof record.data === "string") {
          const bytes = Buffer.from(record.data, "base64");
          const outputPath = await this.writeBlobResource(
            serverName,
            `${promptName}-${record.type}`,
            record.mimeType,
            blobIndex,
            bytes
          );
          blobIndex += 1;
          normalizedContents.push({
            type: record.type,
            mimeType: record.mimeType,
            outputPath,
            sizeBytes: bytes.length,
            base64Length: record.data.length
          });
          continue;
        }

        if (record.type === "resource" && record.resource && typeof record.resource === "object") {
          const resource = record.resource as Record<string, unknown>;
          const uri = typeof resource.uri === "string" ? resource.uri : "";
          const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
          if (typeof resource.text === "string") {
            normalizedContents.push({
              type: "resource_text",
              uri,
              ...(mimeType ? { mimeType } : {}),
              text: truncate(resource.text, maxTextChars),
              length: resource.text.length,
              truncated: resource.text.length > maxTextChars
            });
            continue;
          }

          if (typeof resource.blob === "string") {
            const bytes = Buffer.from(resource.blob, "base64");
            const outputPath = await this.writeBlobResource(
              serverName,
              uri || `${promptName}-resource`,
              mimeType,
              blobIndex,
              bytes
            );
            blobIndex += 1;
            normalizedContents.push({
              type: "resource_blob",
              uri,
              ...(mimeType ? { mimeType } : {}),
              outputPath,
              sizeBytes: bytes.length,
              base64Length: resource.blob.length
            });
            continue;
          }
        }

        if (record.type === "resource_link" &&
          typeof record.uri === "string" &&
          typeof record.name === "string") {
          normalizedContents.push({
            type: "resource_link",
            uri: record.uri,
            name: record.name,
            ...(typeof record.title === "string" ? { title: record.title } : {}),
            ...(typeof record.description === "string" ? { description: record.description } : {}),
            ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
            ...(typeof record.size === "number" ? { size: record.size } : {})
          });
        }
      }

      normalized.push({
        role: message.role,
        content: normalizedContents
      });
    }

    return normalized;
  }

  private async writeBlobResource(
    serverName: string,
    uri: string,
    mimeType: string | undefined,
    index: number,
    bytes: Buffer
  ): Promise<string> {
    await fs.mkdir(this.outputDirectory, { recursive: true });
    const fileName = [
      sanitizeFileName(serverName),
      new Date().toISOString().replace(/[:.]/g, "-"),
      randomUUID().slice(0, 8),
      index,
      sanitizeFileName(uri || "resource").slice(0, 80)
    ].join("-") + extensionForMimeType(mimeType);
    const outputPath = path.join(this.outputDirectory, fileName);
    await fs.writeFile(outputPath, bytes);
    return outputPath;
  }

  private rebuildToolIndex() {
    this.toolsByExposedName.clear();
    this.toolSchemasCache = [];
    const connectedServers = [...this.servers.values()].filter((server) => server.status === "connected");
    const totalConnectedTools = connectedServers.reduce((total, server) => total + server.tools.length, 0);
    const useExposureBudget = totalConnectedTools > DIRECT_MCP_TOOL_EXPOSURE_LIMIT;

    for (const server of this.servers.values()) {
      if (server.status !== "connected") {
        server.directToolCount = 0;
        server.hiddenToolCount = 0;
        server.toolExposure = "direct";
        continue;
      }

      if (useExposureBudget) {
        server.directToolCount = 0;
        server.hiddenToolCount = server.tools.length;
        server.toolExposure = "budgeted";
        continue;
      }

      server.directToolCount = server.tools.length;
      server.hiddenToolCount = 0;
      server.toolExposure = "direct";
      for (const tool of server.tools) {
        if (!this.toolsByExposedName.has(tool.exposedName)) {
          this.toolsByExposedName.set(tool.exposedName, tool);
          this.toolSchemasCache.push(createToolSchema(tool));
        }
      }
    }
  }
}

