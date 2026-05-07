import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpConfig, McpServerConfig } from "./types.js";

const McpStdioServerConfigSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    startup_timeout_ms: z.number().int().positive().optional(),
    connect_timeout_ms: z.number().int().positive().optional(),
    list_timeout_ms: z.number().int().positive().optional(),
    call_timeout_ms: z.number().int().positive().optional(),
    read_timeout_ms: z.number().int().positive().optional(),
    close_timeout_ms: z.number().int().positive().optional()
  })
  .strict();

const McpRemoteServerConfigSchema = z
  .object({
    type: z.enum(["streamable_http", "sse"]).optional(),
    url: z.string().trim().url(),
    headers: z.record(z.string()).optional(),
    startup_timeout_ms: z.number().int().positive().optional(),
    connect_timeout_ms: z.number().int().positive().optional(),
    list_timeout_ms: z.number().int().positive().optional(),
    call_timeout_ms: z.number().int().positive().optional(),
    read_timeout_ms: z.number().int().positive().optional(),
    close_timeout_ms: z.number().int().positive().optional()
  })
  .strict();

const McpServerConfigSchema = z.union([
  McpStdioServerConfigSchema,
  McpRemoteServerConfigSchema
]);

const McpConfigFileSchema = z
  .object({
    mcpServers: z.record(McpServerConfigSchema).optional()
  })
  .strict();

type ParsedMcpServerConfig = z.infer<typeof McpServerConfigSchema>;

export async function loadProjectMcpConfig(
  workspaceRoot: string
): Promise<McpConfig> {
  const configPath = path.join(workspaceRoot, ".alyce", "mcp.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { mcpServers: {} };
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read MCP config ${configPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP config JSON ${configPath}: ${message}`);
  }

  try {
    const config = McpConfigFileSchema.parse(parsed);
    return {
      mcpServers: normalizeMcpServers(config.mcpServers ?? {}, workspaceRoot)
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid MCP config ${configPath}: ${details}`);
    }

    throw error;
  }
}

function normalizeMcpServers(
  servers: Record<string, ParsedMcpServerConfig>,
  workspaceRoot: string
): Record<string, McpServerConfig> {
  const normalized: Record<string, McpServerConfig> = {};
  for (const [serverName, server] of Object.entries(servers)) {
    const normalizedName = normalizeMcpServerName(serverName);
    if (!normalizedName) {
      continue;
    }

    normalized[normalizedName] = normalizeMcpServerConfig(server, workspaceRoot);
  }

  return normalized;
}

function normalizeMcpServerConfig(
  server: ParsedMcpServerConfig,
  workspaceRoot: string
): McpServerConfig {
  if ("url" in server) {
    return {
      type: server.type ?? "streamable_http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
      ...normalizeTimeouts(server)
    };
  }

  return {
    type: "stdio",
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: path.resolve(workspaceRoot, server.cwd) } : {}),
    ...normalizeTimeouts(server)
  };
}

function normalizeTimeouts(server: ParsedMcpServerConfig) {
  return {
    ...(server.startup_timeout_ms ? { startup_timeout_ms: server.startup_timeout_ms } : {}),
    ...(server.connect_timeout_ms ? { connect_timeout_ms: server.connect_timeout_ms } : {}),
    ...(server.list_timeout_ms ? { list_timeout_ms: server.list_timeout_ms } : {}),
    ...(server.call_timeout_ms ? { call_timeout_ms: server.call_timeout_ms } : {}),
    ...(server.read_timeout_ms ? { read_timeout_ms: server.read_timeout_ms } : {}),
    ...(server.close_timeout_ms ? { close_timeout_ms: server.close_timeout_ms } : {})
  };
}

export function normalizeMcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
