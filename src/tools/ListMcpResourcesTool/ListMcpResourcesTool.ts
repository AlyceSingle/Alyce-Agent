import { z } from "zod";
import type { McpListResourcesResult } from "../../mcp/types.js";
import type { ToolExecutionContext } from "../types.js";

export const LIST_MCP_RESOURCES_TOOL_NAME = "ListMcpResources";

export const ListMcpResourcesInputSchema = z
  .object({
    server: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional normalized MCP server name from .alyce/mcp.json. Omit to list resources from all servers.")
  })
  .strict();

export const LIST_MCP_RESOURCES_TOOL_DESCRIPTION = [
  "List resources exposed by configured MCP servers.",
  "Can filter by server name. Individual server failures are returned per server instead of failing the whole request."
].join("\n");

export async function executeListMcpResourcesTool(
  input: z.infer<typeof ListMcpResourcesInputSchema>,
  context: ToolExecutionContext
): Promise<McpListResourcesResult> {
  if (!context.mcpRuntime) {
    throw new Error("MCP runtime is not available in this execution context.");
  }

  const approved = await context.requestApproval({
    kind: "mcp",
    toolName: LIST_MCP_RESOURCES_TOOL_NAME,
    title: "List MCP resources",
    summary: input.server ? `Server: ${input.server}` : "All configured MCP servers",
    details: [
      input.server ? `Server: ${input.server}` : "Server: (all configured servers)",
      "Operation: resources/list"
    ]
  });
  if (!approved) {
    return {
      servers: [{
        server: input.server ?? "(all)",
        status: "error",
        resources: [],
        error: "User rejected the MCP resources list request."
      }],
      resourceCount: 0
    };
  }

  const result = await context.mcpRuntime.listResources({
    serverName: input.server,
    abortSignal: context.abortSignal,
    timeoutMs: context.commandTimeoutMs
  });
  context.recordToolActivity?.(LIST_MCP_RESOURCES_TOOL_NAME);
  return result;
}
