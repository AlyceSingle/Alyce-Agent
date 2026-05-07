import type OpenAI from "openai";
import type { JsonRecord, ToolApprovalRequest } from "../tools/types.js";

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface McpBaseServerConfig {
  startup_timeout_ms?: number;
  connect_timeout_ms?: number;
  list_timeout_ms?: number;
  call_timeout_ms?: number;
  read_timeout_ms?: number;
  close_timeout_ms?: number;
}

export interface McpStdioServerConfig extends McpBaseServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpRemoteServerConfig extends McpBaseServerConfig {
  type: "streamable_http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "error" | "initializing" | "not_initialized";
  transport: McpServerConfig["type"];
  endpoint: string;
  error?: string;
  lastOperation?: string;
  lastOperationStartedAt?: string;
  lastOperationCompletedAt?: string;
  lastErrorAt?: string;
  lastTimeoutMs?: number;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  toolCount: number;
}

export interface McpStatusResult {
  servers: McpServerStatus[];
  message?: string;
}

export interface McpResourceSummary {
  server: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpServerResourceList {
  server: string;
  status: "completed" | "error" | "unsupported" | "not_found";
  resources: McpResourceSummary[];
  error?: string;
  nextCursor?: string;
}

export interface McpListResourcesResult {
  servers: McpServerResourceList[];
  resourceCount: number;
}

export type McpReadResourceContent =
  | {
      type: "text";
      uri: string;
      mimeType?: string;
      text: string;
      length: number;
      truncated: boolean;
    }
  | {
      type: "blob";
      uri: string;
      mimeType?: string;
      outputPath: string;
      sizeBytes: number;
      base64Length: number;
    };

export interface McpReadResourceResult {
  status: "completed" | "error" | "unsupported" | "not_found";
  server: string;
  uri: string;
  contents: McpReadResourceContent[];
  error?: string;
}

export interface McpToolRuntime {
  getToolSchemas: (
    options?: { abortSignal?: AbortSignal; initialize?: boolean }
  ) => Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  canExecuteTool: (toolName: string) => boolean;
  executeToolCall: (
    toolName: string,
    args: JsonRecord,
    options: {
      requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ) => Promise<unknown>;
  getStatus: (options?: {
    abortSignal?: AbortSignal;
    initialize?: boolean;
  }) => Promise<McpStatusResult>;
  listResources: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<McpListResourcesResult>;
  readResource: (
    serverName: string,
    uri: string,
    options?: {
      maxTextChars?: number;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ) => Promise<McpReadResourceResult>;
  close: () => Promise<void>;
}
