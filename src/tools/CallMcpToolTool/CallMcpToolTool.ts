import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";

export const CALL_MCP_TOOL_TOOL_NAME = "CallMcpTool";

export const CallMcpToolInputSchema = z
  .object({
    server: z
      .string()
      .trim()
      .min(1)
      .describe("Normalized MCP server name."),
    tool: z
      .string()
      .trim()
      .min(1)
      .describe("Original MCP tool name returned by ListMcpTools."),
    arguments: z
      .record(z.unknown())
      .optional()
      .describe("JSON object arguments passed through to the selected MCP tool.")
  })
  .strict();

export const CALL_MCP_TOOL_TOOL_DESCRIPTION = [
  "Invoke an MCP tool by server name and original tool name.",
  "Use this after ListMcpTools when direct per-tool MCP exposure is budgeted or when you need to call a hidden MCP tool."
].join("\n");

export async function executeCallMcpToolTool(
  input: z.infer<typeof CallMcpToolInputSchema>,
  context: ToolExecutionContext
) {
  if (!context.mcpRuntime) {
    throw new Error("MCP runtime is not available in this execution context.");
  }

  const result = await context.mcpRuntime.executeNamedToolCall(
    input.server,
    input.tool,
    input.arguments ?? {},
    {
      requestApproval: context.requestApproval,
      abortSignal: context.abortSignal,
      timeoutMs: context.commandTimeoutMs
    }
  );

  const record = result && typeof result === "object" ? result as { status?: string } : null;
  if (record?.status === "completed") {
    context.recordToolActivity?.(CALL_MCP_TOOL_TOOL_NAME);
  }

  return result;
}
