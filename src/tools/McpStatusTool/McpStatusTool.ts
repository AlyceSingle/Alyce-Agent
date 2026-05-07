import { z } from "zod";
import type { McpStatusResult } from "../../mcp/types.js";
import type { ToolExecutionContext } from "../types.js";

export const MCP_STATUS_TOOL_NAME = "McpStatus";

export const McpStatusInputSchema = z
  .object({
    initialize: z
      .boolean()
      .optional()
      .describe("When true, connect configured MCP servers before reporting status. Defaults to true for tool use.")
  })
  .strict();

export const MCP_STATUS_TOOL_DESCRIPTION = [
  "Show configured MCP servers, connection state, transport, endpoint, advertised capabilities, and exposed tool counts.",
  "By default this connects servers so capabilities and dynamic tool counts are current; after it connects, dynamic MCP tools can appear in later model requests.",
  "Use this before ListMcpResources or ReadMcpResource when you need to inspect MCP availability."
].join("\n");

export async function executeMcpStatusTool(
  input: z.infer<typeof McpStatusInputSchema>,
  context: ToolExecutionContext
): Promise<McpStatusResult> {
  if (!context.mcpRuntime) {
    throw new Error("MCP runtime is not available in this execution context.");
  }

  const initialize = input.initialize ?? true;
  if (initialize) {
    const approved = await context.requestApproval({
      kind: "mcp",
      toolName: MCP_STATUS_TOOL_NAME,
      title: "Initialize MCP servers",
      summary: "Connect configured MCP servers and refresh capabilities",
      details: [
        "Operation: initialize configured MCP servers",
        "This may start local stdio MCP commands or connect to remote MCP endpoints from .alyce/mcp.json."
      ]
    });
    if (!approved) {
      return {
        servers: [],
        message: "User rejected MCP initialization."
      };
    }
  }

  const status = await context.mcpRuntime.getStatus({
    abortSignal: context.abortSignal,
    initialize
  });
  if (!initialize) {
    return status;
  }

  context.recordToolActivity?.(MCP_STATUS_TOOL_NAME);
  return {
    ...status,
    message: "MCP status refreshed. Dynamic MCP tools from connected servers can be used after the tool schema refresh."
  };
}
