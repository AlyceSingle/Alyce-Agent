import type { JsonRecord, ToolApprovalRequest } from "../tools/types.js";
import type { McpApprovalAction, McpServerConfig } from "./types.js";
import type { McpServerRuntime, McpToolMetadata } from "./runtimeTypes.js";
import { formatEndpoint } from "./normalize.js";
import { truncate } from "./timeouts.js";

// MCP 工具审批策略与 impact 分类。

export function resolveMcpToolApprovalAction(
  config: McpServerConfig,
  toolName: string
): McpApprovalAction {
  const scoped = config.approval?.tools?.[toolName];
  if (scoped === "allow" || scoped === "deny" || scoped === "ask") {
    return scoped;
  }

  const fallback = config.approval?.default;
  if (fallback === "allow" || fallback === "deny" || fallback === "ask") {
    return fallback;
  }

  return "ask";
}

export function buildMcpToolApprovalRequest(
  server: McpServerRuntime,
  tool: McpToolMetadata,
  args: JsonRecord
): ToolApprovalRequest {
  const impact = classifyMcpToolImpact(tool.originalName, args);
  const pattern = `${tool.serverName}.${tool.originalName}`;
  return {
    kind: "mcp",
    toolName: tool.exposedName,
    title: "Call MCP tool",
    summary: `${tool.serverName}.${tool.originalName}`,
    details: [
      `Server: ${tool.serverName}`,
      `Tool: ${tool.originalName}`,
      `Endpoint: ${formatEndpoint(server.config)}`,
      `Policy scope: mcp.tool:${pattern}`,
      `Impact: ${impact.summary}`,
      `Arguments: ${truncate(JSON.stringify(args), 1000)}`,
      ...impact.notes.map((note) => `Review: ${note}`)
    ],
    permission: {
      permission: "mcp.tool",
      pattern
    }
  };
}
export function classifyMcpToolImpact(toolName: string, args: JsonRecord) {
  const normalizedName = toolName.toLowerCase();
  const argText = JSON.stringify(args).toLowerCase();
  const notes: string[] = [];

  if (/(delete|remove|destroy|drop|revoke|terminate|shutdown)/.test(normalizedName)) {
    notes.push("This tool name suggests destructive remote actions or data removal.");
  }
  if (/(create|update|write|edit|merge|push|deploy|publish|submit|approve|send)/.test(normalizedName)) {
    notes.push("This tool name suggests remote state changes, writes, or side effects.");
  }
  if (/(secret|token|cookie|credential|password|key)/.test(normalizedName) ||
    /(secret|token|cookie|credential|password|key)/.test(argText)) {
    notes.push("Arguments or tool name may involve secrets or credential-bearing material.");
  }
  if (/(http|url|network|request|webhook)/.test(normalizedName) ||
    /(https?:\/\/)/.test(argText)) {
    notes.push("This request references network endpoints or outbound remote interactions.");
  }

  if (notes.length === 0) {
    return {
      summary: "External MCP call with no obvious high-risk keywords.",
      notes
    };
  }

  return {
    summary: "External MCP call with elevated review signals.",
    notes
  };
}

