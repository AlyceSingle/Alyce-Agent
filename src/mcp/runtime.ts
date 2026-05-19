import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getAbortReason, isTurnInterruptedError, throwIfAborted, TurnInterruptedError } from "../core/abort.js";
import type { FunctionParameters } from "../core/api/openaiFunctionTools.js";
import type { JsonRecord, ToolApprovalRequest } from "../tools/types.js";
import { loadProjectMcpConfig } from "./config.js";
import { encodeMcpToolName } from "./toolNames.js";
import type {
  McpConfig,
  McpListResourcesResult,
  McpReadResourceContent,
  McpReadResourceResult,
  McpResourceSummary,
  McpServerConfig,
  McpServerResourceList,
  McpStatusResult,
  McpToolRuntime
} from "./types.js";

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_MCP_OPERATION_TIMEOUT_MS = 60_000;
const MCP_CLOSE_TIMEOUT_MS = 2_000;

interface McpRuntimeOperationOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onTimeoutOrAbort?: () => void;
}

interface McpServerRuntime {
  name: string;
  config: McpServerConfig;
  client?: Client;
  transport?: Transport;
  tools: McpToolMetadata[];
  error?: string;
  lastOperation?: string;
  lastOperationStartedAt?: string;
  lastOperationCompletedAt?: string;
  lastErrorAt?: string;
  lastTimeoutMs?: number;
  initialized: boolean;
  initializing?: Promise<void>;
  initializationRunId?: number;
}

interface McpToolMetadata {
  exposedName: string;
  originalName: string;
  description: string;
  inputSchema: FunctionParameters;
  serverName: string;
}

export async function createProjectMcpRuntime(workspaceRoot: string): Promise<McpToolRuntime> {
  try {
    const config = await loadProjectMcpConfig(workspaceRoot);
    return new ProjectMcpRuntime(workspaceRoot, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new ProjectMcpRuntime(workspaceRoot, {
      mcpServers: {
        configuration: {
          type: "stdio",
          command: ""
        }
      }
    }, message);
  }
}

export class ProjectMcpRuntime implements McpToolRuntime {
  private readonly servers = new Map<string, McpServerRuntime>();
  private readonly toolsByExposedName = new Map<string, McpToolMetadata>();
  private readonly outputDirectory: string;
  private initializationRunCounter = 0;

  constructor(
    private readonly workspaceRoot: string,
    config: McpConfig,
    configurationError?: string
  ) {
    this.outputDirectory = path.join(workspaceRoot, ".alyce", "mcp-output");
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      this.servers.set(name, {
        name,
        config: serverConfig,
        tools: [],
        initialized: false,
        ...(configurationError ? { error: configurationError } : {})
      });
    }
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
    return [...this.toolsByExposedName.values()].map((tool) => ({
      type: "function",
      function: {
        name: tool.exposedName,
        description: buildMcpToolDescription(tool),
        parameters: tool.inputSchema
      }
    }));
  }

  canExecuteTool(toolName: string): boolean {
    return this.toolsByExposedName.has(toolName);
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
    if (!server?.client) {
      return {
        status: "error",
        error: "mcp_server_unavailable",
        server: tool.serverName,
        tool: tool.originalName,
        message: server?.error ?? `MCP server is unavailable: ${tool.serverName}`
      };
    }

    const approved = await options.requestApproval({
      kind: "mcp",
      toolName,
      title: "Call MCP tool",
      summary: `${tool.serverName}.${tool.originalName}`,
      details: [
        `Server: ${tool.serverName}`,
        `Tool: ${tool.originalName}`,
        `Endpoint: ${formatEndpoint(server.config)}`,
        `Arguments: ${truncate(JSON.stringify(args), 1000)}`
      ]
    });

    if (!approved) {
      return {
        status: "rejected",
        server: tool.serverName,
        tool: tool.originalName,
        message: "User rejected the MCP tool request."
      };
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

    return {
      servers: [...this.servers.values()]
        .map((server) => {
          const capabilities = server.client?.getServerCapabilities();
          return {
            name: server.name,
            status: server.error
              ? "error" as const
              : server.initialized
                ? "connected" as const
                : server.initializing
                  ? "initializing" as const
                  : "not_initialized" as const,
            transport: server.config.type,
            endpoint: formatEndpoint(server.config),
            ...(server.error ? { error: server.error } : {}),
            ...(server.lastOperation ? { lastOperation: server.lastOperation } : {}),
            ...(server.lastOperationStartedAt ? { lastOperationStartedAt: server.lastOperationStartedAt } : {}),
            ...(server.lastOperationCompletedAt ? { lastOperationCompletedAt: server.lastOperationCompletedAt } : {}),
            ...(server.lastErrorAt ? { lastErrorAt: server.lastErrorAt } : {}),
            ...(server.lastTimeoutMs ? { lastTimeoutMs: server.lastTimeoutMs } : {}),
            capabilities: {
              tools: Boolean(capabilities?.tools),
              resources: Boolean(capabilities?.resources),
              prompts: Boolean(capabilities?.prompts)
            },
            toolCount: server.tools.length
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name))
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
    const server = this.servers.get(serverName);
    if (!server) {
      return {
        status: "not_found",
        server: serverName,
        uri,
        contents: [],
        error: `Unknown MCP server: ${serverName}`
      };
    }

    if (!server.client || server.error) {
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

  async close(): Promise<void> {
    const closing: Array<Promise<void>> = [];
    this.toolsByExposedName.clear();
    for (const server of this.servers.values()) {
      this.invalidateInitializationRun(server);
      server.error = server.error ?? (server.initializing ? "MCP runtime closed during initialization." : undefined);
      server.initializing = undefined;
      server.tools = [];
      if (server.transport) {
        try {
          const closeResult = server.transport.close();
          const closeTimeoutMs = resolveMcpTimeout(server, "close");
          closing.push(withTimeout(
            trackServerOperation(
              server,
              "close",
              closeTimeoutMs,
              () => closeResult instanceof Promise ? closeResult : Promise.resolve(closeResult)
            ),
            closeTimeoutMs,
            `MCP server '${server.name}' did not close in time.`
          ).catch(() => undefined));
        } catch {}
      }
      server.client = undefined;
      server.transport = undefined;
      server.initialized = false;
    }

    await Promise.allSettled(closing);
  }

  private async ensureInitialized(options: { abortSignal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.abortSignal);
    const servers = [...this.servers.values()];
    await Promise.all(servers.map((server) => this.ensureServerInitialized(server, options)));
    throwIfAborted(options.abortSignal);
    this.rebuildToolIndex();
  }

  private async ensureServerInitialized(
    server: McpServerRuntime,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<void> {
    throwIfAborted(options.abortSignal);
    if (server.initialized || server.error) {
      return;
    }

    if (!server.initializing) {
      const runId = this.nextInitializationRunId(server);
      server.initializing = this.initializeServer(server, runId, options);
    }

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

  private async initializeServer(
    server: McpServerRuntime,
    runId: number,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<void> {
    let transport: Transport | undefined;
    const errorChunks: string[] = [];

    try {
      const client = new Client({
        name: "alyce",
        version: "0.1.10"
      }, {
        capabilities: {}
      });
      transport = createTransport(server, this.workspaceRoot);
      const activeTransport = transport;

      server.transport = activeTransport;
      activeTransport.onerror = (error) => {
        appendErrorChunk(errorChunks, error.message);
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
          "connect",
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

      server.tools = tools;
      server.initialized = true;
      server.error = undefined;
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        if (isCurrentInitializationRun(server, runId)) {
          server.tools = [];
          server.initialized = false;
        }
        await closeTransportWithTimeout(server, transport);
        if (isCurrentInitializationRun(server, runId)) {
          server.client = undefined;
          server.transport = undefined;
        }
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const details = errorChunks.join("").trim();
      if (isCurrentInitializationRun(server, runId)) {
        server.error = details ? `${message}\n${truncate(details, 1200)}` : message;
        server.tools = [];
        server.initialized = false;
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

  private getSelectedServers(serverName: string | undefined): McpServerRuntime[] {
    if (!serverName) {
      return [...this.servers.values()];
    }

    const server = this.servers.get(serverName);
    if (server) {
      return [server];
    }

    return [{
      name: serverName,
      config: {
        type: "stdio",
        command: ""
      },
      tools: [],
      initialized: false,
      error: `Unknown MCP server: ${serverName}`
    }];
  }

  private async listServerResources(
    server: McpServerRuntime,
    options: McpRuntimeOperationOptions
  ): Promise<McpServerResourceList> {
    if (!server.client || server.error) {
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
    for (const server of this.servers.values()) {
      for (const tool of server.tools) {
        if (!this.toolsByExposedName.has(tool.exposedName)) {
          this.toolsByExposedName.set(tool.exposedName, tool);
        }
      }
    }
  }
}

function createTransport(server: McpServerRuntime, workspaceRoot: string): Transport {
  if (server.config.type === "stdio") {
    return new StdioClientTransport({
      command: server.config.command,
      args: server.config.args ?? [],
      env: server.config.env,
      cwd: server.config.cwd ? path.resolve(workspaceRoot, server.config.cwd) : workspaceRoot,
      stderr: "pipe"
    });
  }

  const requestInit = server.config.headers
    ? { headers: server.config.headers }
    : undefined;
  if (server.config.type === "sse") {
    return new SSEClientTransport(new URL(server.config.url), {
      requestInit
    });
  }

  return new StreamableHTTPClientTransport(new URL(server.config.url), {
    requestInit
  });
}

async function listServerTools(
  server: McpServerRuntime,
  client: Client,
  options: McpRuntimeOperationOptions
): Promise<McpToolMetadata[]> {
  if (!client.getServerCapabilities()?.tools) {
    return [];
  }

  const timeoutMs = resolveMcpTimeout(server, "list", options.timeoutMs);
  const listed = await withTimeout(
    trackServerOperation(
      server,
      "listTools",
      timeoutMs,
      () => client.listTools(undefined, {
        signal: options.abortSignal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs
      })
    ),
    timeoutMs,
    `MCP server '${server.name}' did not list tools in time.`,
    {
      abortSignal: options.abortSignal,
      onTimeoutOrAbort: options.onTimeoutOrAbort
    }
  );
  const usedNames = new Set<string>();
  return listed.tools.map((tool) => {
    const exposedName = createUniqueMcpToolName(server.name, tool.name, usedNames);
    usedNames.add(exposedName);
    return {
      serverName: server.name,
      exposedName,
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: normalizeInputSchema(tool.inputSchema)
    };
  });
}

function createUniqueMcpToolName(
  serverName: string,
  toolName: string,
  usedNames: Set<string>
) {
  const baseName = encodeMcpToolName(serverName, toolName);
  if (!usedNames.has(baseName)) {
    return baseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${baseName.slice(0, 64 - suffix.length)}${suffix}`;
    if (!usedNames.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Too many MCP tool name collisions for server '${serverName}'.`);
}

function normalizeInputSchema(schema: unknown): FunctionParameters {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {}
    } as FunctionParameters;
  }

  const record = { ...(schema as Record<string, unknown>) };
  if (record.type !== "object") {
    record.type = "object";
  }
  if (!record.properties || typeof record.properties !== "object") {
    record.properties = {};
  }

  return record as FunctionParameters;
}

function releaseInitializingServer(server: McpServerRuntime, runId: number) {
  if (server.initializationRunId === runId) {
    server.initializing = undefined;
  }
}

function isCurrentInitializationRun(server: McpServerRuntime, runId: number) {
  return server.initializationRunId === runId;
}

async function closeTransportWithTimeout(
  server: McpServerRuntime,
  transport: Transport | undefined
) {
  if (!transport) {
    return;
  }

  try {
    const closeResult = transport.close();
    const closeTimeoutMs = resolveMcpTimeout(server, "close");
    await withTimeout(
      closeResult instanceof Promise ? closeResult : Promise.resolve(closeResult),
      closeTimeoutMs,
      `MCP server '${server.name}' did not close in time.`
    );
  } catch {}
}

function closeTransportQuietly(transport: Transport) {
  try {
    const closeResult = transport.close();
    if (closeResult instanceof Promise) {
      void closeResult.catch(() => undefined);
    }
  } catch {}
}

function normalizeMcpToolResult(tool: McpToolMetadata, result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return {
    status: record.isError === true ? "error" : "completed",
    server: tool.serverName,
    tool: tool.originalName,
    content: normalizeContent(record.content),
    structuredContent: record.structuredContent,
    isError: record.isError === true,
    raw: result
  };
}

function normalizeContent(content: unknown) {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }

    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return {
        type: "text",
        text: record.text
      };
    }

    if (record.type === "resource") {
      return {
        type: "resource",
        resource: record.resource
      };
    }

    if (record.type === "image" || record.type === "audio" || record.type === "resource_link") {
      return record;
    }

    return record;
  });
}

function buildMcpToolDescription(tool: McpToolMetadata) {
  return [
    `MCP tool from server '${tool.serverName}'.`,
    tool.description
  ].filter(Boolean).join("\n");
}

function formatEndpoint(config: McpServerConfig) {
  if (config.type !== "stdio") {
    return config.url;
  }

  return [config.command, ...(config.args ?? [])].join(" ");
}

type McpTimeoutKind = "connect" | "list" | "call" | "read" | "close";

function resolveMcpTimeout(
  server: McpServerRuntime,
  kind: McpTimeoutKind,
  overrideMs?: number
): number {
  if (overrideMs !== undefined) {
    return Math.max(1, Math.trunc(overrideMs));
  }

  switch (kind) {
    case "connect":
      return server.config.connect_timeout_ms ??
        server.config.startup_timeout_ms ??
        DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    case "list":
      return server.config.list_timeout_ms ??
        server.config.startup_timeout_ms ??
        DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    case "call":
      return server.config.call_timeout_ms ?? DEFAULT_MCP_OPERATION_TIMEOUT_MS;
    case "read":
      return server.config.read_timeout_ms ?? DEFAULT_MCP_OPERATION_TIMEOUT_MS;
    case "close":
      return server.config.close_timeout_ms ?? MCP_CLOSE_TIMEOUT_MS;
  }
}

async function trackServerOperation<T>(
  server: McpServerRuntime,
  operation: string,
  timeoutMs: number,
  execute: () => Promise<T>
): Promise<T> {
  server.lastOperation = operation;
  server.lastOperationStartedAt = new Date().toISOString();
  server.lastTimeoutMs = timeoutMs;
  try {
    const result = await execute();
    server.lastOperationCompletedAt = new Date().toISOString();
    return result;
  } catch (error) {
    server.lastErrorAt = new Date().toISOString();
    throw error;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  options: { abortSignal?: AbortSignal; onTimeoutOrAbort?: () => void } = {}
): Promise<T> {
  throwIfAborted(options.abortSignal);
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      options.onTimeoutOrAbort?.();
      reject(new Error(message));
    }, timeoutMs);
  });
  const candidates: Array<Promise<T> | Promise<never>> = [promise, timeout];

  const abortSignal = options.abortSignal;
  if (abortSignal) {
    candidates.push(new Promise<never>((_resolve, reject) => {
      abortHandler = () => {
        options.onTimeoutOrAbort?.();
        reject(createAbortRaceError(abortSignal));
      };
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }));
  }

  return Promise.race(candidates).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  });
}

function withAbort<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  throwIfAborted(abortSignal);
  if (!abortSignal) {
    return promise;
  }

  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => {
      reject(createAbortRaceError(abortSignal));
    };
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  });

  return Promise.race([promise, aborted]).finally(() => {
    if (abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  });
}

function createAbortRaceError(abortSignal: AbortSignal): Error {
  if (abortSignal.reason instanceof Error) {
    return abortSignal.reason;
  }

  return new TurnInterruptedError(getAbortReason(abortSignal) ?? "aborted");
}

function truncate(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function appendErrorChunk(chunks: string[], chunk: string) {
  chunks.push(chunk);
  if (chunks.join("").length > 4000) {
    chunks.splice(0, chunks.length - 8);
  }
}

function normalizeResourceSummary(
  serverName: string,
  resource: {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
  }
): McpResourceSummary {
  return {
    server: serverName,
    uri: resource.uri,
    name: resource.name,
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(resource.size !== undefined ? { size: resource.size } : {})
  };
}

function sanitizeFileName(value: string) {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "resource";
}

function extensionForMimeType(mimeType: string | undefined) {
  switch (mimeType) {
    case "application/json":
      return ".json";
    case "application/pdf":
      return ".pdf";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "text/plain":
      return ".txt";
    default:
      return ".bin";
  }
}
