import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  parseRequestPatchOperations,
  type RequestPatchOperation
} from "../core/api/requestPatch.js";
import {
  getBuiltinPersonaPresetNames,
  resolveBuiltinPersonaPreset
} from "../core/prompt/fragments/personaPresets.js";
import {
  normalizeModelContextWindowOverrides,
  type ModelContextWindowOverrides
} from "../core/context/modelContextWindows.js";
import type { PermissionRuleInput } from "../core/permissions/permissionRules.js";
import {
  buildProviderRegistry,
  mergeProviderProfileMaps,
  normalizeProviderProfileInputMap,
  type ProviderProfileInputMap
} from "../core/providers/registry.js";
import {
  loadConnectorPlugins,
  type ConnectorPluginDiagnostic
} from "../core/providers/pluginConnectors.js";
import { getBuiltInProviderConnectors } from "../core/providers/connectors/index.js";
import type { ProviderConnector } from "../core/providers/providerAuth.js";
import type { ProviderProfileMap } from "../core/providers/types.js";
import {
  getProjectTrustKey,
  getProjectTrustState,
  type ProjectTrustState
} from "../core/trust/projectTrustStore.js";
import {
  logStartupTiming,
  measureStartupTiming
} from "../core/startup/startupTiming.js";

export interface PromptOverrideConfig {
  languagePreference?: string;
  personaPreset?: string;
  aiPersonalityPrompt?: string;
  appendSystemPrompt?: string;
}

export interface MemoryRuntimeConfig {
  directory: string;
  fileName: string;
  maxSessionEntries: number;
  maxPersistentEntries: number;
  maxPromptEntries: number;
  sessionMemory: {
    enabled: boolean;
    initialTokens: number;
    updateTokens: number;
    toolCallsBetweenUpdates: number;
    timeoutMs: number;
    maxFailures: number;
    staleMs: number;
    maxMessagesForExtraction: number;
    maxCharsPerMessage: number;
  };
}

export type SnapshotEngine = "hybrid" | "git-tree" | "file-backup";

export interface SnapshotRuntimeConfig {
  enabled: boolean;
  engine: SnapshotEngine;
  maxTextDiffBytes: number;
  maxFileBytes: number;
  retentionDays: number;
  includeIgnoredExplicitPaths: boolean;
  manifestScan: boolean;
}

export interface ConnectionConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

export type ConnectionConfigLayer = Partial<ConnectionConfig> & {
  providers?: ProviderProfileInputMap;
};

export type ConnectionConfigSaveTarget = "user" | "project";

export type ApprovalMode = "read-only" | "default" | "auto-review" | "full-access";
type ApprovalModeInput = ApprovalMode | "manual" | "auto";

export type UiLocale = "en" | "zh";

export interface SessionSettings extends PromptOverrideConfig {
  uiLanguage: UiLocale;
  approvalMode: ApprovalMode;
  maxSteps: number;
  commandTimeoutMs: number;
  scrollSpeed: number;
  scrollAccelerationEnabled: boolean;
  historyPagingEnabled: boolean;
  maxMessagesWithoutVirtualization: number;
  sessionMemoryEnabled: boolean;
  /** 注入 API 请求的“当前系统时间”上下文（模型可见，界面不展示）。 */
  messageTimestampsEnabled: boolean;
  /** 是否在对话 transcript 消息旁显示本地时钟（如 3:45 PM），默认关闭。 */
  showMessageTimestamps: boolean;
  markdownMessageRenderingEnabled: boolean;
  markdownToolMessageRenderingEnabled: boolean;
  markdownRenderMaxChars: number;
  thinkingMessagesExpandedByDefault: boolean;
  diagnosticsPendingTimeoutMs: number;
  diagnosticsFailureThreshold: number;
  diagnosticsFailureCooldownMs: number;
  snapshot: SnapshotRuntimeConfig;
  conversationCompactionEnabled: boolean;
  autoCompactTimeoutMs: number;
  autoCompactMaxFailures: number;
  modelContextWindowOverrides: ModelContextWindowOverrides;
  additionalDirectories: string[];
  permissionRules: PermissionRuleInput[];
}

export type ConnectionConfigSource = "default" | "user" | "project" | "env" | "cli";
export type SessionSettingsSource = "default" | "project" | "user" | "env" | "cli";

export interface ConnectionConfigState {
  effective: ConnectionConfig;
  user: ConnectionConfigLayer;
  project: ConnectionConfigLayer;
  env: Partial<ConnectionConfig>;
  cli: Partial<ConnectionConfig>;
  sources: Record<keyof ConnectionConfig, ConnectionConfigSource>;
  providerProfiles: ProviderProfileMap;
  saveTarget: ConnectionConfigSaveTarget;
  saveTargetPath: string;
  userPath: string;
  projectPath: string;
}

export interface SessionSettingsState {
  effective: SessionSettings;
  project: Partial<SessionSettings>;
  user: Partial<SessionSettings>;
  env: Partial<SessionSettings>;
  cli: Partial<SessionSettings>;
  sources: Record<keyof SessionSettings, SessionSettingsSource>;
  saveTargetPath: string;
  projectPath: string;
}

export interface RuntimePaths {
  workspaceRoot: string;
  projectAlyceDirectory: string;
  alyceDirectory: string;
  connectionConfigPath: string;
  settingsConfigPath: string;
  projectSkillsDirectory: string;
  projectAgentsDirectory: string;
  projectPluginsDirectory: string;
  userAlyceDirectory: string;
  userConnectionConfigPath: string;
  userSettingsConfigPath: string;
  userSkillsDirectory: string;
  userPluginsDirectory: string;
  workspaceRuntimeDirectory: string;
  memoryDirectory: string;
  sessionsDirectory: string;
  backgroundProcessesDirectory: string;
  mcpOutputDirectory: string;
  snapshotsDirectory: string;
  gitSnapshotsDirectory: string;
  fileHistoryDirectory: string;
  tasksDirectory: string;
  usageLogPath: string;
  projectTrustStorePath: string;
}

export interface RuntimeBootstrapFailure {
  path: string;
  error: string;
}

export interface RuntimeBootstrapReport {
  createdPaths: string[];
  existingPaths: string[];
  failedPaths: RuntimeBootstrapFailure[];
  firstRun: boolean;
}

export interface RuntimeConfig {
  paths: RuntimePaths;
  bootstrap: RuntimeBootstrapReport;
  projectTrust: ProjectTrustState;
  connection: ConnectionConfig;
  connectionState: ConnectionConfigState;
  settings: SessionSettings;
  settingsState: SessionSettingsState;
  providerConnectors: ProviderConnector[];
  providerPluginProfiles: ProviderProfileInputMap;
  providerPluginDiagnostics: ConnectorPluginDiagnostic[];
  requestPatches: RequestPatchOperation[];
  memory: MemoryRuntimeConfig;
}

const ConnectionConfigFileSchema = z
  .object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string().optional(),
    providers: z.record(z.object({
      id: z.string().optional(),
      label: z.string().optional(),
      kind: z.union([
        z.literal("openai-compatible"),
        z.literal("openai"),
        z.literal("anthropic"),
        z.literal("google"),
        z.literal("openrouter"),
        z.literal("local")
      ]).optional(),
      apiKeyEnv: z.string().optional(),
      apiKey: z.string().optional(),
      baseURL: z.string().optional(),
      defaultModel: z.string().optional(),
      models: z.record(z.object({
        label: z.string().optional(),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        inputCostPerMillionTokens: z.number().nonnegative().optional(),
        outputCostPerMillionTokens: z.number().nonnegative().optional()
      }).strict()).optional()
    }).strict()).optional()
  })
  .strict();

type SessionSettingsFile = Omit<Partial<SessionSettings>, "snapshot" | "approvalMode"> & {
  approvalMode?: ApprovalModeInput;
  snapshot?: Partial<SnapshotRuntimeConfig>;
  autoSummaryEnabled?: boolean;
  statusUsageDisplayEnabled?: boolean;
  startupInstructionFiles?: string[];
};

const SessionSettingsFileSchema: z.ZodType<SessionSettingsFile> = z
  .object({
    uiLanguage: z.union([z.literal("en"), z.literal("zh")]).optional(),
    approvalMode: z.union([
      z.literal("read-only"),
      z.literal("default"),
      z.literal("auto-review"),
      z.literal("full-access"),
      // Legacy aliases kept so existing settings files continue to load.
      z.literal("manual"),
      z.literal("auto")
    ]).optional(),
    maxSteps: z.number().int().positive().optional(),
    commandTimeoutMs: z.number().int().positive().optional(),
    scrollSpeed: z.number().int().positive().optional(),
    scrollAccelerationEnabled: z.boolean().optional(),
    historyPagingEnabled: z.boolean().optional(),
    maxMessagesWithoutVirtualization: z.number().int().positive().optional(),
    sessionMemoryEnabled: z.boolean().optional(),
    // Accept the retired setting as a compatibility alias.
    autoSummaryEnabled: z.boolean().optional(),
    messageTimestampsEnabled: z.boolean().optional(),
    showMessageTimestamps: z.boolean().optional(),
    markdownMessageRenderingEnabled: z.boolean().optional(),
    markdownToolMessageRenderingEnabled: z.boolean().optional(),
    markdownRenderMaxChars: z.number().int().positive().optional(),
    thinkingMessagesExpandedByDefault: z.boolean().optional(),
    // Accept and discard the removed status-bar usage setting.
    statusUsageDisplayEnabled: z.boolean().optional(),
    diagnosticsPendingTimeoutMs: z.number().int().positive().optional(),
    diagnosticsFailureThreshold: z.number().int().positive().optional(),
    diagnosticsFailureCooldownMs: z.number().int().positive().optional(),
    snapshot: z
      .object({
        enabled: z.boolean().optional(),
        engine: z.union([
          z.literal("hybrid"),
          z.literal("git-tree"),
          z.literal("file-backup")
        ]).optional(),
        maxTextDiffBytes: z.number().int().positive().optional(),
        maxFileBytes: z.number().int().positive().optional(),
        retentionDays: z.number().int().positive().optional(),
        includeIgnoredExplicitPaths: z.boolean().optional(),
        manifestScan: z.boolean().optional()
      })
      .strict()
      .optional(),
    conversationCompactionEnabled: z.boolean().optional(),
    autoCompactTimeoutMs: z.number().int().positive().optional(),
    autoCompactMaxFailures: z.number().int().positive().optional(),
    modelContextWindowOverrides: z.record(z.number().int().positive()).optional(),
    languagePreference: z.string().optional(),
    personaPreset: z.string().optional(),
    aiPersonalityPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    additionalDirectories: z.array(z.string()).optional(),
    permissionRules: z
      .array(
        z
          .object({
            permission: z.union([
              z.literal("*"),
              z.literal("shell"),
              z.literal("powershell"),
              z.literal("file.read"),
              z.literal("file.write"),
              z.literal("file.edit"),
              z.literal("file.patch"),
              z.literal("directory.external"),
              z.literal("web.fetch"),
              z.literal("web.search"),
              z.literal("mcp.tool"),
              z.literal("mcp.resource"),
              z.literal("skill.load"),
              z.literal("task.spawn")
            ]),
            pattern: z.string().optional(),
            action: z.union([z.literal("allow"), z.literal("ask"), z.literal("deny")]),
            scope: z.union([z.literal("session"), z.literal("persistent")]).optional(),
            expiresAt: z.string().optional(),
            reason: z.string().optional(),
            id: z.string().optional()
          })
          .strict()
      )
      .optional(),
    // Accept and discard the removed key so older settings files keep loading cleanly.
    startupInstructionFiles: z.array(z.string()).optional()
  })
  .strict();

export async function loadRuntimeConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<RuntimeConfig> {
  const workspaceRoot = path.resolve(getArgValue(argv, "--cwd") || env.AGENT_WORKSPACE || ".");
  logStartupTiming("runtime:load:start", { workspaceRoot });
  const paths = await measureStartupTiming("runtime:getRuntimePaths", () =>
    Promise.resolve(getRuntimePaths(workspaceRoot))
  );
  logStartupTiming("runtime:paths", {
    workspaceRoot: paths.workspaceRoot,
    projectAlyceDirectory: paths.projectAlyceDirectory,
    userAlyceDirectory: paths.userAlyceDirectory,
    sameProjectAndUserAlyce: paths.projectAlyceDirectory === paths.userAlyceDirectory
  });
  const bootstrap = await measureStartupTiming("runtime:ensureStoragePaths", () =>
    ensureRuntimeStoragePaths(paths)
  );
  logStartupTiming("runtime:bootstrap", {
    firstRun: bootstrap.firstRun,
    createdCount: bootstrap.createdPaths.length,
    existingCount: bootstrap.existingPaths.length,
    failedCount: bootstrap.failedPaths.length
  });
  const projectTrust = await measureStartupTiming("runtime:getProjectTrustState", () =>
    getProjectTrustState(workspaceRoot, {
      userAlyceDirectory: paths.userAlyceDirectory
    })
  );
  const projectTrusted = projectTrust.trusted;
  logStartupTiming("runtime:projectTrust", {
    trusted: projectTrusted
  });
  const enableProjectPlugins = projectTrusted &&
    parseBoolean(env.ALYCE_ENABLE_PROJECT_PROVIDER_PLUGINS, false);
  const [projectConnection, userConnection, projectSettingsFile, userSettingsFile, pluginResult] =
    await measureStartupTiming("runtime:loadConfigAndPlugins", () =>
      Promise.all([
        measureStartupTiming(
          "runtime:readProjectConnectionConfig",
          () => projectTrusted
            ? readJsonConfig(paths.connectionConfigPath, ConnectionConfigFileSchema)
            : Promise.resolve({} as Partial<ConnectionConfigLayer>),
          { path: paths.connectionConfigPath, enabled: projectTrusted }
        ),
        measureStartupTiming(
          "runtime:readUserConnectionConfig",
          () => readJsonConfig(paths.userConnectionConfigPath, ConnectionConfigFileSchema),
          { path: paths.userConnectionConfigPath }
        ),
        measureStartupTiming(
          "runtime:readProjectSettings",
          () => projectTrusted
            ? readJsonConfig(paths.settingsConfigPath, SessionSettingsFileSchema)
            : Promise.resolve({} as Partial<SessionSettingsFile>),
          { path: paths.settingsConfigPath, enabled: projectTrusted }
        ),
        measureStartupTiming(
          "runtime:readUserSettings",
          () => readJsonConfig(paths.userSettingsConfigPath, SessionSettingsFileSchema),
          { path: paths.userSettingsConfigPath }
        ),
        measureStartupTiming(
          "runtime:loadConnectorPlugins",
          () => loadConnectorPlugins({
            userPluginsDirectory: paths.userPluginsDirectory,
            projectPluginsDirectory: paths.projectPluginsDirectory,
            enableProjectPlugins,
            projectTrustDisabledReason: projectTrusted
              ? undefined
              : "Project connector plugins are disabled until this workspace is trusted."
          }),
          {
            userPluginsDirectory: paths.userPluginsDirectory,
            projectPluginsDirectory: paths.projectPluginsDirectory,
            enableProjectPlugins
          }
        )
      ])
    );
  const projectSettings = normalizeSessionSettingsFile(projectSettingsFile);
  const userSettings = normalizeSessionSettingsFile(userSettingsFile);

  const connectionState = await measureStartupTiming("runtime:buildConnectionConfigState", () =>
    Promise.resolve(buildConnectionConfigState(paths, {
      user: userConnection,
      project: projectConnection,
      env: resolveConnectionFromEnv(env),
      cli: resolveConnectionFromCli(argv),
      pluginProviders: pluginResult.providerProfiles
    }))
  );
  const cliSettings = await resolveSettingsFromCli(argv);
  const settingsState = await measureStartupTiming("runtime:buildSessionSettingsState", () =>
    Promise.resolve(buildSessionSettingsState(paths, {
      project: projectSettings,
      user: userSettings,
      env: resolveSettingsFromEnv(env),
      cli: cliSettings
    }))
  );
  logStartupTiming("runtime:load:end", {
    providerConnectorCount: pluginResult.connectors.length,
    providerPluginDiagnosticCount: pluginResult.diagnostics.length
  });

  return {
    paths,
    bootstrap,
    projectTrust,
    connection: connectionState.effective,
    connectionState,
    settings: settingsState.effective,
    settingsState,
    providerConnectors: [
      ...getBuiltInProviderConnectors(),
      ...pluginResult.connectors
    ],
    providerPluginProfiles: pluginResult.providerProfiles,
    providerPluginDiagnostics: pluginResult.diagnostics,
    requestPatches: await resolveRequestPatches(argv, env),
    memory: {
      directory: env.AGENT_MEMORY_DIR || configRelativePath(
        paths.workspaceRoot,
        paths.memoryDirectory
      ),
      fileName: env.AGENT_MEMORY_FILE || "MEMORY.md",
      maxSessionEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_SESSION, 30),
      maxPersistentEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PERSISTENT, 200),
      maxPromptEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PROMPT, 20),
      sessionMemory: {
        enabled: parseBoolean(
          env.AGENT_SESSION_MEMORY_ENABLED ?? env.AGENT_MEMORY_AUTO_SUMMARY,
          true
        ),
        initialTokens: parsePositiveInt(env.AGENT_SESSION_MEMORY_INIT_TOKENS, 10_000),
        updateTokens: parsePositiveInt(env.AGENT_SESSION_MEMORY_UPDATE_TOKENS, 5_000),
        toolCallsBetweenUpdates: parsePositiveInt(env.AGENT_SESSION_MEMORY_TOOL_CALLS, 3),
        timeoutMs: parsePositiveInt(env.AGENT_SESSION_MEMORY_TIMEOUT_MS, 180_000),
        maxFailures: parsePositiveInt(env.AGENT_SESSION_MEMORY_MAX_FAILURES, 3),
        staleMs: parsePositiveInt(env.AGENT_SESSION_MEMORY_STALE_MS, 60_000),
        maxMessagesForExtraction: parsePositiveInt(env.AGENT_SESSION_MEMORY_WINDOW_MESSAGES, 80),
        maxCharsPerMessage: parsePositiveInt(env.AGENT_SESSION_MEMORY_MAX_CHARS_PER_MESSAGE, 1_500)
      }
    }
  };
}

export function getRuntimePaths(workspaceRoot: string): RuntimePaths {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const projectAlyceDirectory = path.join(resolvedWorkspaceRoot, ".alyce");
  const userAlyceDirectory = path.join(os.homedir(), ".alyce");
  const workspaceRuntimeDirectory = path.join(
    userAlyceDirectory,
    "workspace-state",
    getProjectTrustKey(resolvedWorkspaceRoot)
  );

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    projectAlyceDirectory,
    alyceDirectory: workspaceRuntimeDirectory,
    connectionConfigPath: path.join(projectAlyceDirectory, "config.json"),
    settingsConfigPath: path.join(projectAlyceDirectory, "settings.json"),
    projectSkillsDirectory: path.join(projectAlyceDirectory, "skills"),
    projectAgentsDirectory: path.join(projectAlyceDirectory, "agents"),
    projectPluginsDirectory: path.join(projectAlyceDirectory, "plugins"),
    userAlyceDirectory,
    userConnectionConfigPath: path.join(userAlyceDirectory, "config.json"),
    userSettingsConfigPath: path.join(userAlyceDirectory, "settings.json"),
    userSkillsDirectory: path.join(userAlyceDirectory, "skills"),
    userPluginsDirectory: path.join(userAlyceDirectory, "plugins"),
    workspaceRuntimeDirectory,
    memoryDirectory: path.join(workspaceRuntimeDirectory, "memory"),
    sessionsDirectory: path.join(workspaceRuntimeDirectory, "sessions"),
    backgroundProcessesDirectory: path.join(workspaceRuntimeDirectory, "background-processes"),
    mcpOutputDirectory: path.join(workspaceRuntimeDirectory, "mcp-output"),
    snapshotsDirectory: path.join(workspaceRuntimeDirectory, "snapshots"),
    gitSnapshotsDirectory: path.join(workspaceRuntimeDirectory, "snapshots", "git"),
    fileHistoryDirectory: path.join(workspaceRuntimeDirectory, "file-history"),
    tasksDirectory: path.join(workspaceRuntimeDirectory, "tasks"),
    usageLogPath: path.join(workspaceRuntimeDirectory, "usage.jsonl"),
    projectTrustStorePath: path.join(userAlyceDirectory, "trusted-projects.json")
  };
}

export function buildConnectionConfigState(
  paths: Pick<RuntimePaths, "connectionConfigPath" | "userConnectionConfigPath">,
  layers: {
    user?: ConnectionConfigLayer;
    project?: ConnectionConfigLayer;
    env?: Partial<ConnectionConfig>;
    cli?: Partial<ConnectionConfig>;
    pluginProviders?: ProviderProfileInputMap;
    preferredSaveTarget?: ConnectionConfigSaveTarget;
  }
): ConnectionConfigState {
  const user = normalizeConnectionConfigLayer(layers.user);
  const project = normalizeConnectionConfigLayer(layers.project);
  const env = compactObject(layers.env ?? {});
  const cli = compactObject(layers.cli ?? {});
  // OPENAI_* values are startup defaults; saved connection config must override them.
  const orderedLayers: Array<SourceLayer<ConnectionConfig, ConnectionConfigSource>> = [
    { source: "env", values: env },
    { source: "project", values: stripProviderProfiles(project) },
    { source: "user", values: stripProviderProfiles(user) },
    { source: "cli", values: cli }
  ];
  const effective = normalizeConnectionConfig(mergeLayers(orderedLayers));
  const saveTarget = resolveConnectionSaveTarget({
    preferred: layers.preferredSaveTarget,
    user,
    project
  });

  return {
    effective,
    user,
    project,
    env,
    cli,
    sources: buildSourceMap(effective, orderedLayers, "default"),
    providerProfiles: buildProviderRegistry({
      connection: effective,
      configuredProviders: mergeProviderProfileMaps(
        layers.pluginProviders,
        project.providers,
        user.providers
      )
    }).providers,
    saveTarget,
    saveTargetPath:
      saveTarget === "project" ? paths.connectionConfigPath : paths.userConnectionConfigPath,
    userPath: paths.userConnectionConfigPath,
    projectPath: paths.connectionConfigPath
  };
}

export function buildSessionSettingsState(
  paths: Pick<RuntimePaths, "workspaceRoot" | "settingsConfigPath" | "userSettingsConfigPath">,
  layers: {
    project?: Partial<SessionSettings>;
    user?: Partial<SessionSettings>;
    env?: Partial<SessionSettings>;
    cli?: Partial<SessionSettings>;
  }
): SessionSettingsState {
  const orderedLayers: Array<SourceLayer<SessionSettings, SessionSettingsSource>> = [
    { source: "project", values: compactObject(layers.project ?? {}) },
    { source: "user", values: compactObject(layers.user ?? {}) },
    { source: "env", values: compactObject(layers.env ?? {}) },
    { source: "cli", values: compactObject(layers.cli ?? {}) }
  ];
  const effective = normalizeSessionSettings(mergeLayers(orderedLayers), paths.workspaceRoot);

  return {
    effective,
    project: orderedLayers[0]!.values,
    user: orderedLayers[1]!.values,
    env: orderedLayers[2]!.values,
    cli: orderedLayers[3]!.values,
    sources: buildSourceMap(effective, orderedLayers, "default"),
    saveTargetPath: paths.userSettingsConfigPath,
    projectPath: paths.settingsConfigPath
  };
}

export async function saveConnectionConfig(
  paths: RuntimePaths,
  target: ConnectionConfigSaveTarget,
  connection: ConnectionConfigLayer
): Promise<void> {
  await writeJsonConfig(
    target === "project" ? paths.connectionConfigPath : paths.userConnectionConfigPath,
    serializeConnectionConfig(connection)
  );
}

export async function saveUserSessionSettings(
  paths: RuntimePaths,
  settings: Partial<SessionSettings>
): Promise<void> {
  await writeJsonConfig(
    paths.userSettingsConfigPath,
    serializeSessionSettings(settings, paths.workspaceRoot)
  );
}

type SourceLayer<T extends object, Source extends string> = {
  source: Source;
  values: Partial<T>;
};

function mergeLayers<T extends object, Source extends string>(
  layers: Array<SourceLayer<T, Source>>
): Partial<T> {
  // 顺序即优先级，后面的 layer 会覆盖前面的同名字段。
  return Object.assign({}, ...layers.map((layer) => layer.values));
}

function buildSourceMap<T extends object, Source extends string>(
  effective: T,
  layers: Array<SourceLayer<T, Source>>,
  defaultSource: Source
): Record<keyof T, Source> {
  const sources = {} as Record<keyof T, Source>;

  for (const key of Object.keys(effective) as Array<keyof T>) {
    let source = defaultSource;
    // 这里故意与 mergeLayers 使用同一顺序，便于准确追踪"最终值来自哪一层"。
    for (const layer of layers) {
      if (layer.values[key] !== undefined) {
        source = layer.source;
      }
    }

    sources[key] = source;
  }

  return sources;
}

async function resolveRequestPatches(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<RequestPatchOperation[]> {
  const directValue = getArgValue(argv, "--request-patch") ?? env.AGENT_OPENAI_REQUEST_PATCH;
  const fileValue = getArgValue(argv, "--request-patch-file") ?? env.AGENT_OPENAI_REQUEST_PATCH_FILE;

  if (directValue && fileValue) {
    throw new Error("Cannot use --request-patch and --request-patch-file at the same time.");
  }

  if (!directValue && !fileValue) {
    return [];
  }

  if (fileValue) {
    const absolutePath = path.resolve(fileValue);
    try {
      const raw = await fs.readFile(absolutePath, "utf8");
      return parseRequestPatchOperations(raw, absolutePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read request patch file: ${absolutePath}. ${message}`);
    }
  }

  return parseRequestPatchOperations(
    directValue!,
    "--request-patch or AGENT_OPENAI_REQUEST_PATCH"
  );
}

async function resolvePromptTextFromCli(options: {
  argv: string[];
  directFlag: string;
  fileFlag: string;
  label: string;
}): Promise<string | undefined> {
  const directValue = getArgValue(options.argv, options.directFlag);
  const fileValue = getArgValue(options.argv, options.fileFlag);

  if (directValue && fileValue) {
    throw new Error(`Cannot use ${options.directFlag} and ${options.fileFlag} at the same time.`);
  }

  if (fileValue) {
    const absolutePath = path.resolve(fileValue);
    try {
      return await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${options.label} file: ${absolutePath}. ${message}`);
    }
  }

  return directValue;
}

function getArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function getArgValues(argv: string[], flag: string): string[] | undefined {
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) {
      continue;
    }

    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }

    values.push(candidate);
  }

  return values.length > 0 ? values : undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function resolvePersonaPreset(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const resolvedPreset = resolveBuiltinPersonaPreset(normalized);
  if (resolvedPreset) {
    return resolvedPreset;
  }

  const builtinPresets = getBuiltinPersonaPresetNames();
  throw new Error(
    `Unknown persona preset: ${normalized}. Available presets: ${builtinPresets.join(", ")}`
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(parsed));
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(1, Math.trunc(parsed));
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseOptionalBoolean(value);
  return parsed ?? fallback;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}

function normalizeConnectionConfig(input: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    apiKey: input.apiKey?.trim() ?? "",
    baseURL: normalizeOptionalText(input.baseURL),
    model: input.model?.trim() || "gpt-4.1-mini"
  };
}

function normalizeConnectionConfigLayer(
  input: ConnectionConfigLayer | undefined
): ConnectionConfigLayer {
  if (!input) {
    return {};
  }

  const providers = normalizeProviderProfileInputMap(input.providers);
  return compactObject({
    apiKey: "apiKey" in input ? input.apiKey?.trim() ?? "" : undefined,
    baseURL: "baseURL" in input ? normalizeOptionalText(input.baseURL) : undefined,
    model: "model" in input ? normalizeOptionalText(input.model) : undefined,
    providers:
      "providers" in input && Object.keys(providers).length > 0
        ? providers
        : undefined
  });
}

function stripProviderProfiles(input: ConnectionConfigLayer): Partial<ConnectionConfig> {
  const { providers: _providers, ...connection } = input;
  return connection;
}

function normalizeSessionSettingsFile(input: Partial<SessionSettingsFile>): Partial<SessionSettings> {
  const {
    autoSummaryEnabled,
    statusUsageDisplayEnabled: _removedStatusUsageDisplayEnabled,
    startupInstructionFiles: _removedStartupInstructionFiles,
    approvalMode,
    snapshot,
    ...settings
  } = input;
  const normalized: Partial<SessionSettings> = { ...settings };
  if (approvalMode !== undefined) {
    normalized.approvalMode = normalizeApprovalMode(approvalMode);
  }

  if (snapshot !== undefined) {
    normalized.snapshot = normalizeSnapshotSettings(snapshot);
  }

  if (normalized.sessionMemoryEnabled === undefined && autoSummaryEnabled !== undefined) {
    // autoSummaryEnabled is the retired name for session memory; accept it so
    // old settings files keep loading while new writes use sessionMemoryEnabled.
    normalized.sessionMemoryEnabled = autoSummaryEnabled;
  }

  return compactObject(normalized);
}

function serializeConnectionConfig(connection: ConnectionConfigLayer): ConnectionConfigLayer {
  const providers = normalizeProviderProfileInputMap(connection.providers);
  return compactObject({
    apiKey: "apiKey" in connection ? connection.apiKey?.trim() ?? "" : undefined,
    baseURL:
      "baseURL" in connection
        ? connection.baseURL === undefined
          ? ""
          : connection.baseURL.trim()
        : undefined,
    model: "model" in connection ? normalizeOptionalText(connection.model) : undefined,
    providers:
      "providers" in connection && Object.keys(providers).length > 0
        ? providers
        : undefined
  });
}

function normalizeSessionSettings(
  input: Partial<SessionSettings>,
  workspaceRoot: string
): SessionSettings {
  return {
    uiLanguage: input.uiLanguage === "zh" ? "zh" : "en",
    approvalMode: normalizeApprovalMode(input.approvalMode),
    maxSteps: clampPositiveInt(input.maxSteps, 50),
    commandTimeoutMs: clampPositiveInt(input.commandTimeoutMs, 120_000),
    scrollSpeed: clampBoundedInt(input.scrollSpeed, 2, 1, 8),
    scrollAccelerationEnabled: input.scrollAccelerationEnabled ?? false,
    historyPagingEnabled: input.historyPagingEnabled ?? false,
    maxMessagesWithoutVirtualization: clampPositiveInt(input.maxMessagesWithoutVirtualization, 200),
    sessionMemoryEnabled: input.sessionMemoryEnabled ?? true,
    // messageTimestampsEnabled：模型侧系统时间；showMessageTimestamps：UI 消息时钟，默认隐藏。
    messageTimestampsEnabled: input.messageTimestampsEnabled ?? false,
    showMessageTimestamps: input.showMessageTimestamps ?? false,
    markdownMessageRenderingEnabled: input.markdownMessageRenderingEnabled ?? true,
    markdownToolMessageRenderingEnabled: input.markdownToolMessageRenderingEnabled ?? true,
    markdownRenderMaxChars: clampPositiveInt(input.markdownRenderMaxChars, 32_000),
    thinkingMessagesExpandedByDefault: input.thinkingMessagesExpandedByDefault ?? false,
    diagnosticsPendingTimeoutMs: clampPositiveInt(input.diagnosticsPendingTimeoutMs, 120_000),
    diagnosticsFailureThreshold: clampPositiveInt(input.diagnosticsFailureThreshold, 3),
    diagnosticsFailureCooldownMs: clampPositiveInt(input.diagnosticsFailureCooldownMs, 300_000),
    snapshot: normalizeSnapshotSettings(input.snapshot),
    conversationCompactionEnabled: input.conversationCompactionEnabled ?? true,
    autoCompactTimeoutMs: clampPositiveInt(input.autoCompactTimeoutMs, 180_000),
    autoCompactMaxFailures: clampPositiveInt(input.autoCompactMaxFailures, 3),
    modelContextWindowOverrides: normalizeModelContextWindowOverrides(input.modelContextWindowOverrides),
    languagePreference: normalizeOptionalText(input.languagePreference),
    personaPreset: resolvePersonaPreset(normalizeOptionalText(input.personaPreset)),
    aiPersonalityPrompt: normalizeOptionalText(input.aiPersonalityPrompt),
    appendSystemPrompt: normalizeOptionalText(input.appendSystemPrompt),
    additionalDirectories: normalizeAdditionalDirectories(input.additionalDirectories, workspaceRoot),
    permissionRules: normalizePermissionRules(input.permissionRules)
  };
}

function serializeSessionSettings(
  settings: Partial<SessionSettings>,
  workspaceRoot: string
): Partial<SessionSettings> {
  const serialized: Partial<SessionSettings> = {
    uiLanguage: "uiLanguage" in settings ? settings.uiLanguage : undefined,
    approvalMode: "approvalMode" in settings ? settings.approvalMode : undefined,
    maxSteps: "maxSteps" in settings ? settings.maxSteps : undefined,
    commandTimeoutMs: "commandTimeoutMs" in settings ? settings.commandTimeoutMs : undefined,
    scrollSpeed: "scrollSpeed" in settings ? settings.scrollSpeed : undefined,
    scrollAccelerationEnabled:
      "scrollAccelerationEnabled" in settings ? settings.scrollAccelerationEnabled : undefined,
    historyPagingEnabled:
      "historyPagingEnabled" in settings ? settings.historyPagingEnabled : undefined,
    maxMessagesWithoutVirtualization:
      "maxMessagesWithoutVirtualization" in settings
        ? settings.maxMessagesWithoutVirtualization
        : undefined,
    sessionMemoryEnabled:
      "sessionMemoryEnabled" in settings ? settings.sessionMemoryEnabled : undefined,
    messageTimestampsEnabled:
      "messageTimestampsEnabled" in settings ? settings.messageTimestampsEnabled : undefined,
    showMessageTimestamps:
      "showMessageTimestamps" in settings ? settings.showMessageTimestamps : undefined,
    markdownMessageRenderingEnabled:
      "markdownMessageRenderingEnabled" in settings
        ? settings.markdownMessageRenderingEnabled
        : undefined,
    markdownToolMessageRenderingEnabled:
      "markdownToolMessageRenderingEnabled" in settings
        ? settings.markdownToolMessageRenderingEnabled
        : undefined,
    markdownRenderMaxChars:
      "markdownRenderMaxChars" in settings ? settings.markdownRenderMaxChars : undefined,
    thinkingMessagesExpandedByDefault:
      "thinkingMessagesExpandedByDefault" in settings
        ? settings.thinkingMessagesExpandedByDefault
        : undefined,
    diagnosticsPendingTimeoutMs:
      "diagnosticsPendingTimeoutMs" in settings
        ? settings.diagnosticsPendingTimeoutMs
        : undefined,
    diagnosticsFailureThreshold:
      "diagnosticsFailureThreshold" in settings
        ? settings.diagnosticsFailureThreshold
        : undefined,
    diagnosticsFailureCooldownMs:
      "diagnosticsFailureCooldownMs" in settings
        ? settings.diagnosticsFailureCooldownMs
        : undefined,
    snapshot:
      "snapshot" in settings ? normalizeSnapshotSettings(settings.snapshot) : undefined,
    conversationCompactionEnabled:
      "conversationCompactionEnabled" in settings
        ? settings.conversationCompactionEnabled
        : undefined,
    autoCompactTimeoutMs:
      "autoCompactTimeoutMs" in settings ? settings.autoCompactTimeoutMs : undefined,
    autoCompactMaxFailures:
      "autoCompactMaxFailures" in settings ? settings.autoCompactMaxFailures : undefined,
    modelContextWindowOverrides:
      "modelContextWindowOverrides" in settings
        ? normalizeModelContextWindowOverrides(settings.modelContextWindowOverrides)
        : undefined,
    languagePreference:
      "languagePreference" in settings
        ? serializeOptionalTextSetting(settings.languagePreference)
        : undefined,
    personaPreset:
      "personaPreset" in settings
        ? serializePersonaPresetSetting(settings.personaPreset)
        : undefined,
    aiPersonalityPrompt:
      "aiPersonalityPrompt" in settings
        ? serializeOptionalTextSetting(settings.aiPersonalityPrompt)
        : undefined,
    appendSystemPrompt:
      "appendSystemPrompt" in settings
        ? serializeOptionalTextSetting(settings.appendSystemPrompt)
        : undefined,
    additionalDirectories:
      "additionalDirectories" in settings
        ? normalizeAdditionalDirectories(settings.additionalDirectories, workspaceRoot)
        : undefined,
    permissionRules:
      "permissionRules" in settings
        ? normalizePermissionRules(settings.permissionRules)
        : undefined
  };

  if ("modelContextWindowOverrides" in settings) {
    // An empty override map is meaningful: it explicitly clears user-level
    // overrides so project-level patterns do not silently reappear.
    return compactObjectExcept(serialized, new Set<keyof SessionSettings>([
      "modelContextWindowOverrides"
    ]));
  }

  return compactObject({
    ...serialized
  });
}

export function normalizeApprovalMode(value: ApprovalModeInput | undefined): ApprovalMode {
  switch (value) {
    case "read-only":
    case "default":
    case "auto-review":
    case "full-access":
      return value;
    case "auto":
      return "full-access";
    case "manual":
    default:
      return "default";
  }
}

function serializeOptionalTextSetting(value: string | undefined): string | undefined {
  // 空字符串是"显式清空用户层值"的标记，用于覆盖项目层默认值。
  if (value === "") {
    return "";
  }

  return normalizeOptionalText(value);
}

function serializePersonaPresetSetting(value: string | undefined): string | undefined {
  if (value === "") {
    return "";
  }

  return resolvePersonaPreset(normalizeOptionalText(value));
}

function resolveConnectionFromEnv(env: NodeJS.ProcessEnv): Partial<ConnectionConfig> {
  return compactObject({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL
  });
}

function resolveConnectionFromCli(argv: string[]): Partial<ConnectionConfig> {
  return compactObject({
    model: getArgValue(argv, "--model")
  });
}

function resolveSettingsFromEnv(env: NodeJS.ProcessEnv): Partial<SessionSettings> {
  return compactObject({
    maxSteps: parseOptionalPositiveInt(env.AGENT_MAX_STEPS),
    commandTimeoutMs: parseOptionalPositiveInt(env.AGENT_COMMAND_TIMEOUT_MS),
    scrollSpeed: parseOptionalPositiveInt(env.AGENT_SCROLL_SPEED),
    scrollAccelerationEnabled: parseOptionalBoolean(env.AGENT_SCROLL_ACCELERATION_ENABLED),
    historyPagingEnabled: parseOptionalBoolean(env.AGENT_HISTORY_PAGING_ENABLED),
    maxMessagesWithoutVirtualization:
      parseOptionalPositiveInt(env.AGENT_MAX_MESSAGES_WITHOUT_VIRTUALIZATION),
    sessionMemoryEnabled: parseOptionalBoolean(
      env.AGENT_SESSION_MEMORY_ENABLED ?? env.AGENT_MEMORY_AUTO_SUMMARY
    ),
    markdownToolMessageRenderingEnabled: parseOptionalBoolean(
      env.AGENT_MARKDOWN_TOOL_RENDERING_ENABLED
    ),
    markdownRenderMaxChars: parseOptionalPositiveInt(env.AGENT_MARKDOWN_RENDER_MAX_CHARS),
    diagnosticsPendingTimeoutMs: parseOptionalPositiveInt(env.AGENT_DIAGNOSTICS_TIMEOUT_MS),
    diagnosticsFailureThreshold: parseOptionalPositiveInt(env.AGENT_DIAGNOSTICS_FAILURE_THRESHOLD),
    diagnosticsFailureCooldownMs: parseOptionalPositiveInt(env.AGENT_DIAGNOSTICS_FAILURE_COOLDOWN_MS),
    snapshot: resolveSnapshotSettingsFromEnv(env),
    autoCompactTimeoutMs: parseOptionalPositiveInt(env.AGENT_AUTO_COMPACT_TIMEOUT_MS),
    autoCompactMaxFailures: parseOptionalPositiveInt(env.AGENT_AUTO_COMPACT_MAX_FAILURES),
    uiLanguage: env.AGENT_UI_LANGUAGE === "zh" ? "zh" : env.AGENT_UI_LANGUAGE === "en" ? "en" : undefined,
    languagePreference: env.AGENT_LANGUAGE,
    personaPreset: resolvePersonaPreset(env.AGENT_PERSONA_PRESET),
    aiPersonalityPrompt: env.AGENT_AI_PERSONALITY,
    appendSystemPrompt: env.AGENT_APPEND_SYSTEM_PROMPT,
    modelContextWindowOverrides: parseModelContextWindowOverridesFromEnv(
      env.AGENT_MODEL_CONTEXT_WINDOW_OVERRIDES
    ),
    additionalDirectories: parsePathListFromEnv(env.AGENT_ADDITIONAL_DIRECTORIES)
  });
}

function parseModelContextWindowOverridesFromEnv(
  value: string | undefined
): ModelContextWindowOverrides | undefined {
  if (!value) {
    return undefined;
  }

  const parsed: ModelContextWindowOverrides = {};
  for (const entry of value.split(",")) {
    const separatorIndex = entry.lastIndexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const pattern = normalizeOptionalText(entry.slice(0, separatorIndex));
    const tokens = parseOptionalPositiveInt(entry.slice(separatorIndex + 1));
    if (!pattern || tokens === undefined) {
      continue;
    }

    parsed[pattern] = tokens;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

async function resolveSettingsFromCli(argv: string[]): Promise<Partial<SessionSettings>> {
  return compactObject({
    approvalMode: hasFlag(argv, "--yolo") ? "full-access" : undefined,
    uiLanguage: getArgValue(argv, "--ui-lang") === "zh" ? "zh" : getArgValue(argv, "--ui-lang") === "en" ? "en" : undefined,
    languagePreference: getArgValue(argv, "--lang"),
    personaPreset: resolvePersonaPreset(getArgValue(argv, "--persona-preset")),
    aiPersonalityPrompt: getArgValue(argv, "--persona"),
    appendSystemPrompt: await resolvePromptTextFromCli({
      argv,
      directFlag: "--append-system-prompt",
      fileFlag: "--append-system-prompt-file",
      label: "append system prompt"
    }),
    additionalDirectories: getArgValues(argv, "--add-dir")
  });
}

/**
 * Walk the path segments from a Zod "unrecognized_keys" issue and delete the
 * reported keys from the raw parsed config so a second parse succeeds.
 */
function stripUnrecognizedKeys(
  raw: unknown,
  issues: z.ZodIssue[]
): unknown {
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const parentPath = issue.path; // e.g. [] for root, ["snapshot"] for nested
    // Navigate to the parent object
    let parent: unknown = raw;
    for (const segment of parentPath) {
      if (parent == null || typeof parent !== "object") break;
      parent = (parent as Record<string | number, unknown>)[segment];
    }
    if (parent != null && typeof parent === "object") {
      for (const key of issue.keys) {
        delete (parent as Record<string, unknown>)[String(key)];
      }
    }
  }
  return raw;
}

function formatUnrecognizedKeyWarnings(
  filePath: string,
  issues: z.ZodIssue[]
): string {
  return issues
    .filter((i) => i.code === "unrecognized_keys")
    .map((i) => {
      const loc = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  ${loc}: ${i.keys.map((k) => `'${String(k)}'`).join(", ")}`;
    })
    .join("\n");
}

async function readJsonConfig<T>(
  filePath: string,
  schema: z.ZodSchema<T>
): Promise<Partial<T>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = schema.safeParse(parsed);

    if (result.success) {
      return result.data;
    }

    // Separate unrecognized-key issues from real validation errors.
    const unrecognizedIssues = result.error.issues.filter(
      (i) => i.code === "unrecognized_keys"
    );
    const otherIssues = result.error.issues.filter(
      (i) => i.code !== "unrecognized_keys"
    );

    // If there are genuine validation errors (wrong type, invalid value, etc.),
    // surface them exactly as before.
    if (otherIssues.length > 0) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid config file ${filePath}: ${details}`);
    }

    // Only unrecognized keys — warn and strip them so the app keeps working.
    const warnings = formatUnrecognizedKeyWarnings(filePath, unrecognizedIssues);
    process.stderr.write(
      `Warning: unrecognized key(s) in ${filePath} (ignored):\n${warnings}\n`
    );

    stripUnrecognizedKeys(parsed, unrecognizedIssues);
    // Re-parse the cleaned object — should succeed now.
    return schema.parse(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid config file ${filePath}: ${details}`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config file ${filePath}: ${message}`);
  }
}

async function ensureRuntimeStoragePaths(paths: RuntimePaths): Promise<RuntimeBootstrapReport> {
  const createdPaths: string[] = [];
  const existingPaths: string[] = [];
  const failedPaths: RuntimeBootstrapFailure[] = [];

  // 所有目录创建操作互不依赖，并行执行以加速启动。
  const results = await Promise.all(
    getRuntimeBootstrapDirectories(paths).map(async (directory) => {
      logStartupTiming("runtime:ensureStoragePath:start", { directory });
      try {
        const stat = await fs.stat(directory);
        if (!stat.isDirectory()) {
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "failed-not-directory"
          });
          return { type: "failed" as const, path: directory, error: "path exists but is not a directory" };
        }

        logStartupTiming("runtime:ensureStoragePath:end", {
          directory,
          status: "existing"
        });
        return { type: "existing" as const, path: directory };
      } catch (error) {
        if (!isMissingFileError(error)) {
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "failed-stat"
          });
          return { type: "failed" as const, path: directory, error: error instanceof Error ? error.message : String(error) };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "created"
          });
          return { type: "created" as const, path: directory };
        } catch (mkdirError) {
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "failed-mkdir"
          });
          return { type: "failed" as const, path: directory, error: mkdirError instanceof Error ? mkdirError.message : String(mkdirError) };
        }
      }
    })
  );

  for (const result of results) {
    if (result.type === "failed") {
      failedPaths.push({ path: result.path, error: result.error });
    } else if (result.type === "created") {
      createdPaths.push(result.path);
    } else {
      existingPaths.push(result.path);
    }
  }

  return {
    createdPaths,
    existingPaths,
    failedPaths,
    firstRun: createdPaths.includes(paths.userAlyceDirectory) ||
      createdPaths.includes(paths.workspaceRuntimeDirectory)
  };
}

function getRuntimeBootstrapDirectories(paths: RuntimePaths): string[] {
  return [
    paths.userAlyceDirectory,
    paths.userSkillsDirectory,
    paths.userPluginsDirectory,
    paths.workspaceRuntimeDirectory,
    paths.memoryDirectory,
    paths.sessionsDirectory,
    paths.backgroundProcessesDirectory,
    paths.mcpOutputDirectory,
    paths.gitSnapshotsDirectory,
    paths.fileHistoryDirectory,
    paths.tasksDirectory
  ];
}

async function writeJsonConfig(filePath: string, value: object): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value!));
}

export function normalizeSnapshotSettings(
  input: Partial<SnapshotRuntimeConfig> | undefined
): SnapshotRuntimeConfig {
  return {
    enabled: input?.enabled ?? true,
    engine: normalizeSnapshotEngine(input?.engine),
    maxTextDiffBytes: clampPositiveInt(input?.maxTextDiffBytes, 524_288),
    maxFileBytes: clampPositiveInt(input?.maxFileBytes, 2_097_152),
    retentionDays: clampPositiveInt(input?.retentionDays, 7),
    includeIgnoredExplicitPaths: input?.includeIgnoredExplicitPaths ?? true,
    manifestScan: input?.manifestScan ?? true
  };
}

function normalizeSnapshotEngine(value: SnapshotEngine | undefined): SnapshotEngine {
  if (value === "git-tree" || value === "file-backup") {
    return value;
  }

  return "hybrid";
}

function resolveSnapshotSettingsFromEnv(env: NodeJS.ProcessEnv): SnapshotRuntimeConfig | undefined {
  const snapshot: Partial<SnapshotRuntimeConfig> = compactObject({
    enabled: parseOptionalBoolean(env.AGENT_SNAPSHOT_ENABLED),
    engine: parseSnapshotEngine(env.AGENT_SNAPSHOT_ENGINE),
    maxTextDiffBytes: parseOptionalPositiveInt(env.AGENT_SNAPSHOT_MAX_TEXT_DIFF_BYTES),
    maxFileBytes: parseOptionalPositiveInt(env.AGENT_SNAPSHOT_MAX_FILE_BYTES),
    retentionDays: parseOptionalPositiveInt(env.AGENT_SNAPSHOT_RETENTION_DAYS),
    includeIgnoredExplicitPaths: parseOptionalBoolean(
      env.AGENT_SNAPSHOT_INCLUDE_IGNORED_EXPLICIT_PATHS
    ),
    manifestScan: parseOptionalBoolean(env.AGENT_SNAPSHOT_MANIFEST_SCAN)
  });

  return Object.keys(snapshot).length > 0 ? normalizeSnapshotSettings(snapshot) : undefined;
}

function parseSnapshotEngine(value: string | undefined): SnapshotEngine | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "hybrid" || normalized === "git-tree" || normalized === "file-backup") {
    return normalized;
  }

  return undefined;
}

function clampBoundedInt(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(value!)));
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function normalizeAdditionalDirectories(
  value: string[] | undefined,
  workspaceRoot: string
): string[] {
  if (!value || value.length === 0) {
    return [];
  }

  const deduped = new Set<string>();
  for (const directory of value) {
    const normalized = normalizeOptionalText(directory);
    if (!normalized) {
      continue;
    }

    deduped.add(resolveDirectoryInput(normalized, workspaceRoot));
  }

  return [...deduped];
}

function normalizePermissionRules(value: PermissionRuleInput[] | undefined): PermissionRuleInput[] {
  if (!value || value.length === 0) {
    return [];
  }

  return value.map((rule) => ({
    permission: rule.permission,
    action: rule.action,
    ...(rule.pattern?.trim() ? { pattern: rule.pattern.trim() } : {}),
    ...(rule.scope ? { scope: rule.scope } : {}),
    ...(rule.expiresAt?.trim() ? { expiresAt: rule.expiresAt.trim() } : {}),
    ...(rule.reason?.trim() ? { reason: rule.reason.trim() } : {}),
    ...(rule.id?.trim() ? { id: rule.id.trim() } : {})
  }));
}

export function resolveDirectoryInput(directory: string, workspaceRoot: string): string {
  const normalized = directory.trim();
  if (normalized === "~") {
    return path.resolve(os.homedir());
  }

  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), normalized.slice(2)));
  }

  return path.resolve(workspaceRoot, normalized);
}

function parsePathListFromEnv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}

function compactObject<T extends object>(value: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as Partial<T>;
}

function configRelativePath(workspaceRoot: string, absolutePath: string) {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }

  return relative;
}

function compactObjectExcept<T extends object>(
  value: Partial<T>,
  keepKeys: ReadonlySet<keyof T>
): Partial<T> {
  return Object.fromEntries(
    (Object.entries(value) as Array<[keyof T, unknown]>).filter(
      ([entryKey, entryValue]) => entryValue !== undefined || keepKeys.has(entryKey)
    )
  ) as Partial<T>;
}

function resolveConnectionSaveTarget(options: {
  preferred?: ConnectionConfigSaveTarget;
  user: ConnectionConfigLayer;
  project: ConnectionConfigLayer;
}): ConnectionConfigSaveTarget {
  if (options.preferred) {
    return options.preferred;
  }

  // 连接配置通常包含敏感信息，默认优先写入 user 层，避免把密钥写回仓库目录。
  if (Object.keys(options.user).length > 0) {
    return "user";
  }

  return "project";
}
