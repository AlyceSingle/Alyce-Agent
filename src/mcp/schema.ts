import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FunctionParameters } from "../core/api/openaiFunctionTools.js";
import { encodeMcpToolName } from "./toolNames.js";
import type {
  ChatCompletionTool,
  McpRuntimeOperationOptions,
  McpServerRuntime,
  McpToolMetadata
} from "./runtimeTypes.js";
import {
  resolveMcpTimeout,
  trackServerOperation,
  withTimeout
} from "./timeouts.js";

// MCP tool 列表 -> OpenAI function schema 映射与命名。

export async function listServerTools(
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

  return mapListedTools(server.name, listed.tools);
}

export function mapListedTools(
  serverName: string,
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>
): McpToolMetadata[] {
  const usedNames = new Set<string>();
  return tools.map((tool) => {
    const exposedName = createUniqueMcpToolName(serverName, tool.name, usedNames);
    usedNames.add(exposedName);
    return {
      serverName,
      exposedName,
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: normalizeInputSchema(tool.inputSchema)
    };
  });
}

export function createToolSchema(tool: McpToolMetadata): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.exposedName,
      description: buildMcpToolDescription(tool),
      parameters: tool.inputSchema
    }
  };
}

export function setServerTools(server: McpServerRuntime, tools: McpToolMetadata[]) {
  server.tools = tools;
  server.toolsByOriginalName = createToolLookupByOriginalName(tools);
}

export function createToolLookupByOriginalName(tools: McpToolMetadata[]) {
  const lookup = new Map<string, McpToolMetadata>();
  for (const tool of tools) {
    if (!lookup.has(tool.originalName)) {
      lookup.set(tool.originalName, tool);
    }
  }
  return lookup;
}

export function createUniqueMcpToolName(
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

export function normalizeInputSchema(schema: unknown): FunctionParameters {
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
export function buildMcpToolDescription(tool: McpToolMetadata) {
  return [
    `MCP tool from server '${tool.serverName}'.`,
    tool.description
  ].filter(Boolean).join("\n");
}

