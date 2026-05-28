import { z } from "zod";
import type { McpReadResourceResult } from "../../mcp/types.js";
import type { ToolExecutionContext } from "../types.js";

export const READ_MCP_RESOURCE_TOOL_NAME = "ReadMcpResource";
const MAX_TEXT_CHARS = 80_000;

export const ReadMcpResourceInputSchema = z
  .object({
    server: z
      .string()
      .trim()
      .min(1)
      .describe("Normalized MCP server name from .alyce/mcp.json."),
    uri: z
      .string()
      .trim()
      .min(1)
      .describe("Resource URI returned by ListMcpResources."),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(MAX_TEXT_CHARS)
      .optional()
      .describe("Maximum text characters to return for text resources. Defaults to 20000.")
  })
  .strict();

export const READ_MCP_RESOURCE_TOOL_DESCRIPTION = [
  "Read a resource from a configured MCP server by server name and URI.",
  "Text resources are returned inline; binary blob resources are written to the configured MCP output directory and returned as file paths with MIME and size metadata."
].join("\n");

export async function executeReadMcpResourceTool(
  input: z.infer<typeof ReadMcpResourceInputSchema>,
  context: ToolExecutionContext
): Promise<McpReadResourceResult> {
  if (!context.mcpRuntime) {
    throw new Error("MCP runtime is not available in this execution context.");
  }

  const approved = await context.requestApproval({
    kind: "mcp",
    toolName: READ_MCP_RESOURCE_TOOL_NAME,
    title: "Read MCP resource",
    summary: `${input.server}: ${input.uri}`,
    details: [
      `Server: ${input.server}`,
      `URI: ${input.uri}`,
      `Max text chars: ${input.max_chars ?? 20_000}`,
      "Operation: resources/read"
    ]
  });
  if (!approved) {
    return {
      status: "error",
      server: input.server,
      uri: input.uri,
      contents: [],
      error: "User rejected the MCP resource read request."
    };
  }

  const result = await context.mcpRuntime.readResource(input.server, input.uri, {
    maxTextChars: input.max_chars,
    abortSignal: context.abortSignal,
    timeoutMs: context.commandTimeoutMs
  });
  if (result.status === "completed") {
    context.recordToolActivity?.(READ_MCP_RESOURCE_TOOL_NAME);
  }

  return result;
}
