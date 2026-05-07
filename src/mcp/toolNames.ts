const MCP_TOOL_PREFIX = "mcp";
const TOOL_NAME_SEPARATOR = "__";
const MAX_TOOL_NAME_LENGTH = 64;

export interface DecodedMcpToolName {
  serverName: string;
  toolName: string;
}

export function encodeMcpToolName(serverName: string, toolName: string): string {
  const normalizedServer = normalizeToolNamePart(serverName).slice(0, 24);
  const normalizedTool = normalizeToolNamePart(toolName);
  const fixedLength =
    MCP_TOOL_PREFIX.length +
    normalizedServer.length +
    TOOL_NAME_SEPARATOR.length * 2;
  const toolBudget = Math.max(1, MAX_TOOL_NAME_LENGTH - fixedLength);
  return [MCP_TOOL_PREFIX, normalizedServer, normalizedTool.slice(0, toolBudget)]
    .join(TOOL_NAME_SEPARATOR);
}

export function decodeMcpToolName(toolName: string): DecodedMcpToolName | undefined {
  const parts = toolName.split(TOOL_NAME_SEPARATOR);
  if (parts.length !== 3 || parts[0] !== MCP_TOOL_PREFIX || !parts[1] || !parts[2]) {
    return undefined;
  }

  return {
    serverName: parts[1],
    toolName: parts[2]
  };
}

function normalizeToolNamePart(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "unnamed";
}
