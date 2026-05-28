import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  McpApprovalPolicy,
  McpConfig,
  McpConfigMutationResult,
  McpConfigPaths,
  McpConfigScope,
  McpConfigState,
  McpServerConfig
} from "./types.js";

const MCP_SCOPE_ORDER: McpConfigScope[] = ["user", "project", "local"];

const McpApprovalPolicySchema = z
  .object({
    default: z.enum(["allow", "ask", "deny"]).optional(),
    tools: z.record(z.enum(["allow", "ask", "deny"])).optional()
  })
  .strict();

const McpStdioServerConfigSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
    startup_timeout_ms: z.number().int().positive().optional(),
    connect_timeout_ms: z.number().int().positive().optional(),
    list_timeout_ms: z.number().int().positive().optional(),
    call_timeout_ms: z.number().int().positive().optional(),
    read_timeout_ms: z.number().int().positive().optional(),
    close_timeout_ms: z.number().int().positive().optional(),
    approval: McpApprovalPolicySchema.optional(),
    plugin_source: z.string().trim().min(1).optional()
  })
  .strict();

const McpRemoteServerConfigSchema = z
  .object({
    type: z.enum(["streamable_http", "sse"]).optional(),
    url: z.string().trim().url(),
    headers: z.record(z.string()).optional(),
    bearer_token_env_var: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
    startup_timeout_ms: z.number().int().positive().optional(),
    connect_timeout_ms: z.number().int().positive().optional(),
    list_timeout_ms: z.number().int().positive().optional(),
    call_timeout_ms: z.number().int().positive().optional(),
    read_timeout_ms: z.number().int().positive().optional(),
    close_timeout_ms: z.number().int().positive().optional(),
    approval: McpApprovalPolicySchema.optional(),
    plugin_source: z.string().trim().min(1).optional()
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

interface LoadMcpConfigOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  trustedProject?: boolean;
}

export function getMcpConfigPaths(
  workspaceRoot: string,
  homeDirectory = os.homedir()
): McpConfigPaths {
  return {
    project: path.join(workspaceRoot, ".alyce", "mcp.json"),
    local: path.join(workspaceRoot, ".alyce", "mcp.local.json"),
    user: path.join(homeDirectory, ".alyce", "mcp.json")
  };
}

export async function loadProjectMcpConfig(
  workspaceRoot: string
): Promise<McpConfig> {
  const rawConfig = await readMcpConfigFile(getMcpConfigPaths(workspaceRoot).project);
  return {
    mcpServers: resolveEffectiveServers(
      rawConfig.mcpServers,
      "project",
      workspaceRoot,
      process.env,
      os.homedir()
    )
  };
}

export async function loadMcpConfigState(
  workspaceRoot: string,
  options: LoadMcpConfigOptions = {}
): Promise<McpConfigState> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const paths = getMcpConfigPaths(workspaceRoot, homeDirectory);
  const trustedProject = options.trustedProject !== false;
  const configs: Record<McpConfigScope, McpConfig> = {
    user: await readMcpConfigFile(paths.user),
    project: trustedProject ? await readMcpConfigFile(paths.project) : { mcpServers: {} },
    local: trustedProject ? await readMcpConfigFile(paths.local) : { mcpServers: {} }
  };

  return buildMcpConfigState(workspaceRoot, configs, {
    env: options.env,
    homeDirectory
  });
}

export function buildMcpConfigState(
  workspaceRoot: string,
  configs: Record<McpConfigScope, McpConfig>,
  options: LoadMcpConfigOptions = {}
): McpConfigState {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const effective: McpConfig = { mcpServers: {} };
  const sources: Record<string, McpConfigScope> = {};

  for (const scope of MCP_SCOPE_ORDER) {
    for (const [serverName, serverConfig] of Object.entries(configs[scope].mcpServers)) {
      effective.mcpServers[serverName] = resolveServerConfig(
        serverConfig,
        scope,
        workspaceRoot,
        env,
        homeDirectory
      );
      sources[serverName] = scope;
    }
  }

  return {
    paths: getMcpConfigPaths(workspaceRoot, homeDirectory),
    configs: {
      user: cloneMcpConfig(configs.user),
      project: cloneMcpConfig(configs.project),
      local: cloneMcpConfig(configs.local)
    },
    effective,
    sources
  };
}

export async function writeMcpServerConfig(
  workspaceRoot: string,
  scope: McpConfigScope,
  name: string,
  config: McpServerConfig,
  options: LoadMcpConfigOptions = {}
): Promise<McpConfigMutationResult> {
  assertTrustedProjectScope(scope, options);
  const state = await loadMcpConfigState(workspaceRoot, options);
  const normalizedName = normalizeMcpServerName(name);
  if (!normalizedName) {
    throw new Error("MCP server name cannot be empty.");
  }

  const nextScopeConfig = cloneMcpConfig(state.configs[scope]);
  const nextConfig = normalizeParsedServerConfig(cloneServerConfig(config));
  const previous = nextScopeConfig.mcpServers[normalizedName];
  nextScopeConfig.mcpServers[normalizedName] = nextConfig;

  const changed = !isSameConfig(previous, nextConfig);
  if (changed) {
    await writeMcpConfigFile(state.paths[scope], nextScopeConfig);
  }

  return {
    changed,
    scope,
    serverName: normalizedName,
    configPath: state.paths[scope],
    state: changed
      ? await loadMcpConfigState(workspaceRoot, options)
      : state
  };
}

export async function removeMcpServerConfig(
  workspaceRoot: string,
  scope: McpConfigScope,
  name: string,
  options: LoadMcpConfigOptions = {}
): Promise<McpConfigMutationResult> {
  assertTrustedProjectScope(scope, options);
  const state = await loadMcpConfigState(workspaceRoot, options);
  const normalizedName = normalizeMcpServerName(name);
  if (!normalizedName) {
    throw new Error("MCP server name cannot be empty.");
  }

  const nextScopeConfig = cloneMcpConfig(state.configs[scope]);
  const changed = normalizedName in nextScopeConfig.mcpServers;
  if (changed) {
    delete nextScopeConfig.mcpServers[normalizedName];
    await writeMcpConfigFile(state.paths[scope], nextScopeConfig);
  }

  return {
    changed,
    scope,
    serverName: normalizedName,
    configPath: state.paths[scope],
    state: changed
      ? await loadMcpConfigState(workspaceRoot, options)
      : state
  };
}

export async function setScopedMcpServerEnabled(
  workspaceRoot: string,
  scope: McpConfigScope,
  name: string,
  enabled: boolean,
  options: LoadMcpConfigOptions = {}
): Promise<McpConfigMutationResult> {
  assertTrustedProjectScope(scope, options);
  const state = await loadMcpConfigState(workspaceRoot, options);
  const normalizedName = normalizeMcpServerName(name);
  if (!normalizedName) {
    throw new Error("MCP server name cannot be empty.");
  }

  const nextScopeConfig = cloneMcpConfig(state.configs[scope]);
  const current = nextScopeConfig.mcpServers[normalizedName] ?? getSourceServerConfig(state, normalizedName);
  if (!current) {
    throw new Error(`Unknown MCP server: ${normalizedName}`);
  }

  const nextConfig = normalizeParsedServerConfig({
    ...cloneServerConfig(current),
    enabled
  });
  const previous = nextScopeConfig.mcpServers[normalizedName];
  nextScopeConfig.mcpServers[normalizedName] = nextConfig;

  const changed = !isSameConfig(previous, nextConfig);
  if (changed) {
    await writeMcpConfigFile(state.paths[scope], nextScopeConfig);
  }

  return {
    changed,
    scope,
    serverName: normalizedName,
    configPath: state.paths[scope],
    state: changed
      ? await loadMcpConfigState(workspaceRoot, options)
      : state
  };
}

export function normalizeMcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function assertTrustedProjectScope(scope: McpConfigScope, options: LoadMcpConfigOptions) {
  if (scope !== "user" && options.trustedProject === false) {
    throw new Error("Project MCP config is disabled until this workspace is trusted.");
  }
}

async function readMcpConfigFile(configPath: string): Promise<McpConfig> {
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
      mcpServers: normalizeMcpServers(config.mcpServers ?? {})
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

async function writeMcpConfigFile(configPath: string, config: McpConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const contents = JSON.stringify(
    {
      mcpServers: sortRecord(config.mcpServers)
    },
    null,
    2
  ) + "\n";
  await fs.writeFile(configPath, contents, "utf8");
}

function normalizeMcpServers(
  servers: Record<string, ParsedMcpServerConfig | McpServerConfig>
): Record<string, McpServerConfig> {
  const normalized: Record<string, McpServerConfig> = {};
  for (const [serverName, server] of Object.entries(servers)) {
    const normalizedName = normalizeMcpServerName(serverName);
    if (!normalizedName) {
      continue;
    }

    normalized[normalizedName] = normalizeParsedServerConfig(server);
  }

  return normalized;
}

function normalizeParsedServerConfig(
  server: ParsedMcpServerConfig | McpServerConfig
): McpServerConfig {
  if ("url" in server) {
    return {
      type: server.type ?? "streamable_http",
      url: server.url,
      ...(server.headers ? { headers: { ...server.headers } } : {}),
      ...(server.bearer_token_env_var
        ? { bearer_token_env_var: server.bearer_token_env_var }
        : {}),
      ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
      ...(server.required !== undefined ? { required: server.required } : {}),
      ...(server.approval ? { approval: cloneApprovalPolicy(server.approval) } : {}),
      ...(server.plugin_source ? { plugin_source: server.plugin_source } : {}),
      ...normalizeTimeouts(server)
    };
  }

  return {
    type: "stdio",
    command: server.command,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
    ...(server.required !== undefined ? { required: server.required } : {}),
    ...(server.approval ? { approval: cloneApprovalPolicy(server.approval) } : {}),
    ...(server.plugin_source ? { plugin_source: server.plugin_source } : {}),
    ...normalizeTimeouts(server)
  };
}

function normalizeTimeouts(server: ParsedMcpServerConfig | McpServerConfig) {
  return {
    ...(server.startup_timeout_ms ? { startup_timeout_ms: server.startup_timeout_ms } : {}),
    ...(server.connect_timeout_ms ? { connect_timeout_ms: server.connect_timeout_ms } : {}),
    ...(server.list_timeout_ms ? { list_timeout_ms: server.list_timeout_ms } : {}),
    ...(server.call_timeout_ms ? { call_timeout_ms: server.call_timeout_ms } : {}),
    ...(server.read_timeout_ms ? { read_timeout_ms: server.read_timeout_ms } : {}),
    ...(server.close_timeout_ms ? { close_timeout_ms: server.close_timeout_ms } : {})
  };
}

function resolveEffectiveServers(
  servers: Record<string, McpServerConfig>,
  scope: McpConfigScope,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  homeDirectory: string
): Record<string, McpServerConfig> {
  const resolved: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    resolved[name] = resolveServerConfig(config, scope, workspaceRoot, env, homeDirectory);
  }

  return resolved;
}

function resolveServerConfig(
  server: McpServerConfig,
  scope: McpConfigScope,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  homeDirectory: string
): McpServerConfig {
  if (server.type !== "stdio") {
  return {
    ...server,
    url: expandEnvironmentVariables(server.url, env),
    ...(server.headers ? { headers: expandRecord(server.headers, env) } : {}),
    ...(server.approval ? { approval: cloneApprovalPolicy(server.approval) } : {}),
    ...(server.plugin_source ? { plugin_source: server.plugin_source } : {})
  };
}

  const scopeBaseDirectory = getScopeBaseDirectory(scope, workspaceRoot, homeDirectory);
  const resolvedCwd = server.cwd
    ? resolveScopedPath(expandEnvironmentVariables(server.cwd, env), scopeBaseDirectory)
    : undefined;

  return {
    ...server,
    command: expandEnvironmentVariables(server.command, env),
    ...(server.args ? { args: server.args.map((value) => expandEnvironmentVariables(value, env)) } : {}),
    ...(server.env ? { env: expandRecord(server.env, env) } : {}),
    ...(resolvedCwd ? { cwd: resolvedCwd } : {})
  };
}

function expandRecord(
  values: Record<string, string>,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    expanded[key] = expandEnvironmentVariables(value, env);
  }

  return expanded;
}

function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value
    .replace(/%([^%]+)%/g, (match, name) => env[name] ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
      const key = String(braced ?? plain ?? "");
      return env[key] ?? match;
    });
}

function resolveScopedPath(value: string, baseDirectory: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(baseDirectory, value);
}

function getScopeBaseDirectory(
  scope: McpConfigScope,
  workspaceRoot: string,
  homeDirectory: string
): string {
  return scope === "user" ? homeDirectory : workspaceRoot;
}

function getSourceServerConfig(
  state: McpConfigState,
  name: string
): McpServerConfig | undefined {
  const scope = state.sources[name];
  if (!scope) {
    return undefined;
  }

  return state.configs[scope].mcpServers[name];
}

function cloneMcpConfig(config: McpConfig): McpConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => [name, cloneServerConfig(server)])
    )
  };
}

function cloneServerConfig(config: McpServerConfig): McpServerConfig {
  if (config.type === "stdio") {
    return {
      ...config,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      ...(config.approval ? { approval: cloneApprovalPolicy(config.approval) } : {})
    };
  }

  return {
    ...config,
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    ...(config.bearer_token_env_var
      ? { bearer_token_env_var: config.bearer_token_env_var }
      : {}),
    ...(config.approval ? { approval: cloneApprovalPolicy(config.approval) } : {})
  };
}

function cloneApprovalPolicy(approval: McpApprovalPolicy): McpApprovalPolicy {
  return {
    ...(approval.default ? { default: approval.default } : {}),
    ...(approval.tools ? { tools: { ...approval.tools } } : {})
  };
}

function isSameConfig(left: McpServerConfig | undefined, right: McpServerConfig): boolean {
  if (!left) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
