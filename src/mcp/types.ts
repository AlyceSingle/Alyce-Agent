import type OpenAI from "openai";
import type { JsonRecord, ToolApprovalRequest } from "../tools/types.js";

export type McpConfigScope = "project" | "local" | "user";

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export type McpApprovalAction = "allow" | "ask" | "deny";

export interface McpApprovalPolicy {
  default?: McpApprovalAction;
  tools?: Record<string, McpApprovalAction>;
}

export interface McpBaseServerConfig {
  enabled?: boolean;
  required?: boolean;
  startup_timeout_ms?: number;
  connect_timeout_ms?: number;
  list_timeout_ms?: number;
  call_timeout_ms?: number;
  read_timeout_ms?: number;
  close_timeout_ms?: number;
  approval?: McpApprovalPolicy;
  plugin_source?: string;
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
  bearer_token_env_var?: string;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpConfigPaths {
  project: string;
  local: string;
  user: string;
}

export interface McpConfigState {
  paths: McpConfigPaths;
  configs: Record<McpConfigScope, McpConfig>;
  effective: McpConfig;
  sources: Record<string, McpConfigScope>;
}

export interface McpConfigMutationResult {
  changed: boolean;
  scope: McpConfigScope;
  serverName: string;
  configPath: string;
  state: McpConfigState;
}

export type McpServerConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "failed"
  | "disabled"
  | "not_initialized"
  | "auth_required";

export interface McpServerStatus {
  name: string;
  scope: McpConfigScope;
  enabled: boolean;
  required: boolean;
  status: McpServerConnectionState;
  transport: McpServerConfig["type"];
  endpoint: string;
  error?: string;
  recentError?: string;
  lastOperation?: string;
  lastOperationStartedAt?: string;
  lastOperationCompletedAt?: string;
  lastConnectedAt?: string;
  lastErrorAt?: string;
  lastTimeoutMs?: number;
  nextReconnectAt?: string;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  toolCount: number;
  directToolCount: number;
  hiddenToolCount: number;
  toolExposure: "direct" | "budgeted";
}

export interface McpStatusResult {
  servers: McpServerStatus[];
  message?: string;
}

export interface McpToolSummary {
  server: string;
  name: string;
  exposedName: string;
  description: string;
}

export interface McpServerToolList {
  server: string;
  status: "completed" | "error" | "not_found" | "disabled";
  tools: McpToolSummary[];
  error?: string;
}

export interface McpListToolsResult {
  servers: McpServerToolList[];
  toolCount: number;
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
  status: "completed" | "error" | "unsupported" | "not_found" | "disabled";
  resources: McpResourceSummary[];
  error?: string;
  nextCursor?: string;
}

export interface McpListResourcesResult {
  servers: McpServerResourceList[];
  resourceCount: number;
}

export interface McpPromptArgumentSummary {
  name: string;
  description?: string;
  required: boolean;
}

export interface McpPromptSummary {
  server: string;
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgumentSummary[];
}

export interface McpServerPromptList {
  server: string;
  status: "completed" | "error" | "unsupported" | "not_found" | "disabled";
  prompts: McpPromptSummary[];
  error?: string;
  nextCursor?: string;
}

export interface McpListPromptsResult {
  servers: McpServerPromptList[];
  promptCount: number;
}

export type McpPromptContent =
  | {
      type: "text";
      text: string;
      length: number;
      truncated: boolean;
    }
  | {
      type: "image" | "audio";
      mimeType: string;
      outputPath: string;
      sizeBytes: number;
      base64Length: number;
    }
  | {
      type: "resource_text";
      uri: string;
      mimeType?: string;
      text: string;
      length: number;
      truncated: boolean;
    }
  | {
      type: "resource_blob";
      uri: string;
      mimeType?: string;
      outputPath: string;
      sizeBytes: number;
      base64Length: number;
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    };

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpPromptContent[];
}

export interface McpPromptResult {
  status: "completed" | "error" | "unsupported" | "not_found" | "disabled";
  server: string;
  name: string;
  description?: string;
  messages: McpPromptMessage[];
  error?: string;
}

export interface McpResourceTemplateSummary {
  server: string;
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpServerResourceTemplateList {
  server: string;
  status: "completed" | "error" | "unsupported" | "not_found" | "disabled";
  resourceTemplates: McpResourceTemplateSummary[];
  error?: string;
  nextCursor?: string;
}

export interface McpListResourceTemplatesResult {
  servers: McpServerResourceTemplateList[];
  resourceTemplateCount: number;
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
  status: "completed" | "error" | "unsupported" | "not_found" | "disabled";
  server: string;
  uri: string;
  contents: McpReadResourceContent[];
  error?: string;
}

export interface McpLoginResult {
  status: "completed" | "error" | "unsupported" | "not_found" | "disabled";
  server: string;
  message: string;
  authorizationUrl?: string;
  redirectUrl?: string;
}

export type McpElicitationAction = "accept" | "cancel" | "decline";

export interface McpElicitationOption {
  value: string;
  label: string;
}

export type McpElicitationField =
  | {
      key: string;
      label: string;
      description?: string;
      kind: "string";
      required: boolean;
      format?: "date" | "uri" | "email" | "date-time";
      minLength?: number;
      maxLength?: number;
      defaultValue?: string;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: "number" | "integer";
      required: boolean;
      minimum?: number;
      maximum?: number;
      defaultValue?: number;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: "boolean";
      required: boolean;
      defaultValue?: boolean;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: "enum";
      required: boolean;
      options: McpElicitationOption[];
      defaultValue?: string;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: "multi_enum";
      required: boolean;
      options: McpElicitationOption[];
      minItems?: number;
      maxItems?: number;
      defaultValue?: string[];
    };

export type McpElicitationRequest =
  | {
      serverName: string;
      mode: "form";
      message: string;
      fields: McpElicitationField[];
    }
  | {
      serverName: string;
      mode: "url";
      message: string;
      url: string;
      elicitationId: string;
    };

export interface McpElicitationResponse {
  action: McpElicitationAction;
  content?: Record<string, string | number | boolean | string[]>;
}

export interface McpElicitationCompleteEvent {
  serverName: string;
  elicitationId: string;
}

export interface McpToolRuntime {
  getToolSchemas: (
    options?: { abortSignal?: AbortSignal; initialize?: boolean }
  ) => Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  canExecuteTool: (toolName: string) => boolean;
  executeNamedToolCall: (
    serverName: string,
    toolName: string,
    args: JsonRecord,
    options: {
      requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ) => Promise<unknown>;
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
  listTools: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
  }) => Promise<McpListToolsResult>;
  listResources: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<McpListResourcesResult>;
  listPrompts: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<McpListPromptsResult>;
  getPrompt: (
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
    options?: {
      maxTextChars?: number;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ) => Promise<McpPromptResult>;
  listResourceTemplates: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<McpListResourceTemplatesResult>;
  readResource: (
    serverName: string,
    uri: string,
    options?: {
      maxTextChars?: number;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ) => Promise<McpReadResourceResult>;
  reloadConfig: () => Promise<void>;
  addServer: (
    name: string,
    config: McpServerConfig,
    options?: { scope?: McpConfigScope }
  ) => Promise<McpConfigMutationResult>;
  removeServer: (
    name: string,
    options?: { scope?: McpConfigScope }
  ) => Promise<McpConfigMutationResult>;
  setServerEnabled: (
    name: string,
    enabled: boolean,
    options?: { scope?: McpConfigScope }
  ) => Promise<McpConfigMutationResult>;
  loginServer: (
    serverName: string,
    options?: {
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      onAuthorizationUrl?: (details: {
        server: string;
        authorizationUrl: string;
        redirectUrl: string;
      }) => void;
    }
  ) => Promise<McpLoginResult>;
  setInteractionHandlers?: (handlers: {
    requestElicitation?: (
      request: McpElicitationRequest,
      options?: { signal?: AbortSignal; timeoutMs?: number }
    ) => Promise<McpElicitationResponse>;
    onElicitationComplete?: (event: McpElicitationCompleteEvent) => void;
  }) => void;
  close: () => Promise<void>;
}
