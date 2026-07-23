import type OpenAI from "openai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FunctionParameters } from "../core/api/openaiFunctionTools.js";
import type { McpConfigScope, McpServerConfig, McpServerConnectionState } from "./types.js";

// MCP runtime 内部共享类型与超时常量（不对外作为稳定 API）。

export type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;


export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 120_000;
export const DEFAULT_MCP_OPERATION_TIMEOUT_MS = 60_000;
export const MCP_CLOSE_TIMEOUT_MS = 2_000;
export const MCP_RECONNECT_BASE_DELAY_MS = 1_000;
export const MCP_RECONNECT_MAX_DELAY_MS = 30_000;
export const MCP_LOGIN_TIMEOUT_MS = 300_000;
export const MCP_PROMPT_TEXT_MAX_CHARS = 20_000;
export const DIRECT_MCP_TOOL_EXPOSURE_LIMIT = 24;

export interface McpRuntimeOperationOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onTimeoutOrAbort?: () => void;
}

export interface McpServerRuntime {
  name: string;
  scope: McpConfigScope;
  config: McpServerConfig;
  status: McpServerConnectionState;
  client?: Client;
  transport?: Transport;
  tools: McpToolMetadata[];
  toolsByOriginalName: Map<string, McpToolMetadata>;
  error?: string;
  recentError?: string;
  lastOperation?: string;
  lastOperationStartedAt?: string;
  lastOperationCompletedAt?: string;
  lastConnectedAt?: string;
  lastErrorAt?: string;
  lastTimeoutMs?: number;
  nextReconnectAt?: string;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
  initializing?: Promise<void>;
  initializationRunId?: number;
  suppressCloseHandling?: boolean;
  directToolCount: number;
  hiddenToolCount: number;
  toolExposure: "direct" | "budgeted";
}

export interface McpToolMetadata {
  exposedName: string;
  originalName: string;
  description: string;
  inputSchema: FunctionParameters;
  serverName: string;
}

export type InitializationReason = "initial" | "reconnect";

