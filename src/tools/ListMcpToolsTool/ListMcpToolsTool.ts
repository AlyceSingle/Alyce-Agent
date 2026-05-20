import { z } from "zod";
import type { McpListToolsResult } from "../../mcp/types.js";
import type { ToolExecutionContext } from "../types.js";

export const LIST_MCP_TOOLS_TOOL_NAME = "ListMcpTools";

export const ListMcpToolsInputSchema = z
  .object({
    server: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional normalized MCP server name. Omit to search across all configured servers."),
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional substring query matched against MCP tool names and descriptions."),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe("Maximum tools to return after filtering. Defaults to 25.")
  })
  .strict();

export const LIST_MCP_TOOLS_TOOL_DESCRIPTION = [
  "List or search MCP tools exposed by configured MCP servers.",
  "Use this when direct MCP tool exposure is budgeted or when you need to discover the exact server/tool name before calling CallMcpTool."
].join("\n");

export async function executeListMcpToolsTool(
  input: z.infer<typeof ListMcpToolsInputSchema>,
  context: ToolExecutionContext
): Promise<McpListToolsResult> {
  if (!context.mcpRuntime) {
    throw new Error("MCP runtime is not available in this execution context.");
  }

  const approved = await context.requestApproval({
    kind: "mcp",
    toolName: LIST_MCP_TOOLS_TOOL_NAME,
    title: "List MCP tools",
    summary: input.server ? `Server: ${input.server}` : "All configured MCP servers",
    details: [
      input.server ? `Server: ${input.server}` : "Server: (all configured servers)",
      input.query ? `Query: ${input.query}` : "Query: (none)",
      `Limit: ${input.limit ?? 25}`,
      "Operation: tools/list"
    ]
  });
  if (!approved) {
    return {
      servers: [{
        server: input.server ?? "(all)",
        status: "error",
        tools: [],
        error: "User rejected the MCP tools list request."
      }],
      toolCount: 0
    };
  }

  const result = await context.mcpRuntime.listTools({
    serverName: input.server,
    abortSignal: context.abortSignal
  });
  const query = input.query?.trim().toLowerCase();
  const limit = input.limit ?? 25;
  let remaining = limit;

  const filteredServers = result.servers.map((server) => {
    if (remaining <= 0 || server.tools.length === 0) {
      return {
        ...server,
        tools: []
      };
    }

    const matched = server.tools.filter((tool) => {
      if (!query) {
        return true;
      }

      return tool.name.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query) ||
        tool.exposedName.toLowerCase().includes(query);
    });
    const limited = matched.slice(0, remaining);
    remaining -= limited.length;
    return {
      ...server,
      tools: limited
    };
  });

  const filteredCount = filteredServers.reduce((total, server) => total + server.tools.length, 0);
  if (filteredCount > 0) {
    context.recordToolActivity?.(LIST_MCP_TOOLS_TOOL_NAME);
  }

  return {
    servers: filteredServers,
    toolCount: filteredCount
  };
}
