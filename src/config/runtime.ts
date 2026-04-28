import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  parseRequestPatchOperations,
  type RequestPatchOperation
} from "../core/api/requestPatch.js";
import { getBuiltinPersonaPresetNames } from "../core/prompt/fragments/personaPresets.js";

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
  autoSummary: {
    enabled: boolean;
    minMessagesToInit: number;
    messagesBetweenUpdates: number;
    windowMessages: number;
    maxCharsPerMessage: number;
  };
}

export interface ConnectionConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

export type ConnectionConfigSaveTarget = "user" | "project";

export type ApprovalMode = "manual" | "auto";

export interface SessionSettings extends PromptOverrideConfig {
  approvalMode: ApprovalMode;
  maxSteps: number;
  commandTimeoutMs: number;
  autoSummaryEnabled: boolean;
  messageTimestampsEnabled: boolean;
  markdownMessageRenderingEnabled: boolean;
  conversationCompactionEnabled: boolean;
  additionalDirectories: string[];
}

export type ConnectionConfigSource = "default" | "user" | "project" | "env" | "cli";
export type SessionSettingsSource = "default" | "project" | "user" | "env" | "cli";

export interface ConnectionConfigState {
  effective: ConnectionConfig;
  user: Partial<ConnectionConfig>;
  project: Partial<ConnectionConfig>;
  env: Partial<ConnectionConfig>;
  cli: Partial<ConnectionConfig>;
  sources: Record<keyof ConnectionConfig, ConnectionConfigSource>;
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
  alyceDirectory: string;
  connectionConfigPath: string;
  settingsConfigPath: string;
  userAlyceDirectory: string;
  userConnectionConfigPath: string;
  userSettingsConfigPath: string;
}

export interface RuntimeConfig {
  paths: RuntimePaths;
  connection: ConnectionConfig;
  connectionState: ConnectionConfigState;
  settings: SessionSettings;
  settingsState: SessionSettingsState;
  requestPatches: RequestPatchOperation[];
  memory: MemoryRuntimeConfig;
}

const ConnectionConfigFileSchema = z
  .object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string().optional()
  })
  .strict();

const SessionSettingsFileSchema = z
  .object({
    approvalMode: z.union([z.literal("manual"), z.literal("auto")]).optional(),
    maxSteps: z.number().int().positive().optional(),
    commandTimeoutMs: z.number().int().positive().optional(),
    autoSummaryEnabled: z.boolean().optional(),
    messageTimestampsEnabled: z.boolean().optional(),
    markdownMessageRenderingEnabled: z.boolean().optional(),
    conversationCompactionEnabled: z.boolean().optional(),
    languagePreference: z.string().optional(),
    personaPreset: z.string().optional(),
    aiPersonalityPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    additionalDirectories: z.array(z.string()).optional(),
    // Accept and discard the removed key so older settings files keep loading cleanly.
    startupInstructionFiles: z.array(z.string()).optional()
  })
  .strict()
  .transform(({ startupInstructionFiles: _removedStartupInstructionFiles, ...settings }) => settings);

export async function loadRuntimeConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<RuntimeConfig> {
  const workspaceRoot = path.resolve(getArgValue(argv, "--cwd") || env.AGENT_WORKSPACE || ".");
  const paths = getRuntimePaths(workspaceRoot);
  const [projectConnection, userConnection, projectSettings, userSettings] = await Promise.all([
    readJsonConfig(paths.connectionConfigPath, ConnectionConfigFileSchema),
    readJsonConfig(paths.userConnectionConfigPath, ConnectionConfigFileSchema),
    readJsonConfig(paths.settingsConfigPath, SessionSettingsFileSchema),
    readJsonConfig(paths.userSettingsConfigPath, SessionSettingsFileSchema)
  ]);

  const connectionState = buildConnectionConfigState(paths, {
    user: userConnection,
    project: projectConnection,
    env: resolveConnectionFromEnv(env),
    cli: resolveConnectionFromCli(argv)
  });
  const settingsState = buildSessionSettingsState(paths, {
    project: projectSettings,
    user: userSettings,
    env: resolveSettingsFromEnv(env),
    cli: resolveSettingsFromCli(argv)
  });

  return {
    paths,
    connection: connectionState.effective,
    connectionState,
    settings: settingsState.effective,
    settingsState,
    requestPatches: resolveRequestPatches(argv, env),
    memory: {
      directory: env.AGENT_MEMORY_DIR || ".alyce/memory",
      fileName: env.AGENT_MEMORY_FILE || "MEMORY.md",
      maxSessionEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_SESSION, 30),
      maxPersistentEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PERSISTENT, 200),
      maxPromptEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PROMPT, 20),
      autoSummary: {
        enabled: parseBoolean(env.AGENT_MEMORY_AUTO_SUMMARY, true),
        minMessagesToInit: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_MIN_MESSAGES, 8),
        messagesBetweenUpdates: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_INTERVAL_MESSAGES, 6),
        windowMessages: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_WINDOW_MESSAGES, 28),
        maxCharsPerMessage: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_MAX_CHARS_PER_MESSAGE, 1000)
      }
    }
  };
}

export function getRuntimePaths(workspaceRoot: string): RuntimePaths {
  const alyceDirectory = path.join(workspaceRoot, ".alyce");
  const userAlyceDirectory = path.join(os.homedir(), ".alyce");

  return {
    workspaceRoot,
    alyceDirectory,
    connectionConfigPath: path.join(alyceDirectory, "config.json"),
    settingsConfigPath: path.join(alyceDirectory, "settings.json"),
    userAlyceDirectory,
    userConnectionConfigPath: path.join(userAlyceDirectory, "config.json"),
    userSettingsConfigPath: path.join(userAlyceDirectory, "settings.json")
  };
}

export function buildConnectionConfigState(
  paths: Pick<RuntimePaths, "connectionConfigPath" | "userConnectionConfigPath">,
  layers: {
    user?: Partial<ConnectionConfig>;
    project?: Partial<ConnectionConfig>;
    env?: Partial<ConnectionConfig>;
    cli?: Partial<ConnectionConfig>;
    preferredSaveTarget?: ConnectionConfigSaveTarget;
  }
): ConnectionConfigState {
  const user = compactObject(layers.user ?? {});
  const project = compactObject(layers.project ?? {});
  const env = compactObject(layers.env ?? {});
  const cli = compactObject(layers.cli ?? {});
  // OPENAI_* values are startup defaults; saved connection config must override them.
  const orderedLayers: Array<SourceLayer<ConnectionConfig, ConnectionConfigSource>> = [
    { source: "env", values: env },
    { source: "project", values: project },
    { source: "user", values: user },
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
  connection: Partial<ConnectionConfig>
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
    // 这里故意与 mergeLayers 使用同一顺序，便于准确追踪“最终值来自哪一层”。
    for (const layer of layers) {
      if (layer.values[key] !== undefined) {
        source = layer.source;
      }
    }

    sources[key] = source;
  }

  return sources;
}

function resolveRequestPatches(
  argv: string[],
  env: NodeJS.ProcessEnv
): RequestPatchOperation[] {
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
      const raw = readFileSync(absolutePath, "utf8");
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

function resolvePromptTextFromCli(options: {
  argv: string[];
  directFlag: string;
  fileFlag: string;
  label: string;
}): string | undefined {
  const directValue = getArgValue(options.argv, options.directFlag);
  const fileValue = getArgValue(options.argv, options.fileFlag);

  if (directValue && fileValue) {
    throw new Error(`Cannot use ${options.directFlag} and ${options.fileFlag} at the same time.`);
  }

  if (fileValue) {
    const absolutePath = path.resolve(fileValue);
    try {
      return readFileSync(absolutePath, "utf8");
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

  const builtinPresets = getBuiltinPersonaPresetNames();
  if (!builtinPresets.includes(normalized as (typeof builtinPresets)[number])) {
    throw new Error(
      `Unknown persona preset: ${normalized}. Available presets: ${builtinPresets.join(", ")}`
    );
  }

  return normalized;
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

function serializeConnectionConfig(connection: Partial<ConnectionConfig>): Partial<ConnectionConfig> {
  return compactObject({
    apiKey: "apiKey" in connection ? connection.apiKey?.trim() ?? "" : undefined,
    baseURL:
      "baseURL" in connection
        ? connection.baseURL === undefined
          ? ""
          : connection.baseURL.trim()
        : undefined,
    model: "model" in connection ? normalizeOptionalText(connection.model) : undefined
  });
}

function normalizeSessionSettings(
  input: Partial<SessionSettings>,
  workspaceRoot: string
): SessionSettings {
  return {
    approvalMode: input.approvalMode === "auto" ? "auto" : "manual",
    maxSteps: clampPositiveInt(input.maxSteps, 8),
    commandTimeoutMs: clampPositiveInt(input.commandTimeoutMs, 120_000),
    autoSummaryEnabled: input.autoSummaryEnabled ?? true,
    messageTimestampsEnabled: input.messageTimestampsEnabled ?? false,
    markdownMessageRenderingEnabled: input.markdownMessageRenderingEnabled ?? true,
    conversationCompactionEnabled: input.conversationCompactionEnabled ?? true,
    languagePreference: normalizeOptionalText(input.languagePreference),
    personaPreset: resolvePersonaPreset(normalizeOptionalText(input.personaPreset)),
    aiPersonalityPrompt: normalizeOptionalText(input.aiPersonalityPrompt),
    appendSystemPrompt: normalizeOptionalText(input.appendSystemPrompt),
    additionalDirectories: normalizeAdditionalDirectories(input.additionalDirectories, workspaceRoot)
  };
}

function serializeSessionSettings(
  settings: Partial<SessionSettings>,
  workspaceRoot: string
): Partial<SessionSettings> {
  return compactObject({
    approvalMode: "approvalMode" in settings ? settings.approvalMode : undefined,
    maxSteps: "maxSteps" in settings ? settings.maxSteps : undefined,
    commandTimeoutMs: "commandTimeoutMs" in settings ? settings.commandTimeoutMs : undefined,
    autoSummaryEnabled:
      "autoSummaryEnabled" in settings ? settings.autoSummaryEnabled : undefined,
    messageTimestampsEnabled:
      "messageTimestampsEnabled" in settings ? settings.messageTimestampsEnabled : undefined,
    markdownMessageRenderingEnabled:
      "markdownMessageRenderingEnabled" in settings
        ? settings.markdownMessageRenderingEnabled
        : undefined,
    conversationCompactionEnabled:
      "conversationCompactionEnabled" in settings
        ? settings.conversationCompactionEnabled
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
        : undefined
  });
}

function serializeOptionalTextSetting(value: string | undefined): string | undefined {
  // 空字符串是“显式清空用户层值”的标记，用于覆盖项目层默认值。
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
    autoSummaryEnabled: parseOptionalBoolean(env.AGENT_MEMORY_AUTO_SUMMARY),
    languagePreference: env.AGENT_LANGUAGE,
    personaPreset: resolvePersonaPreset(env.AGENT_PERSONA_PRESET),
    aiPersonalityPrompt: env.AGENT_AI_PERSONALITY,
    appendSystemPrompt: env.AGENT_APPEND_SYSTEM_PROMPT,
    additionalDirectories: parsePathListFromEnv(env.AGENT_ADDITIONAL_DIRECTORIES)
  });
}

function resolveSettingsFromCli(argv: string[]): Partial<SessionSettings> {
  return compactObject({
    approvalMode: hasFlag(argv, "--yolo") ? "auto" : undefined,
    languagePreference: getArgValue(argv, "--lang"),
    personaPreset: resolvePersonaPreset(getArgValue(argv, "--persona-preset")),
    aiPersonalityPrompt: getArgValue(argv, "--persona"),
    appendSystemPrompt: resolvePromptTextFromCli({
      argv,
      directFlag: "--append-system-prompt",
      fileFlag: "--append-system-prompt-file",
      label: "append system prompt"
    }),
    additionalDirectories: getArgValues(argv, "--add-dir")
  });
}

async function readJsonConfig<T>(
  filePath: string,
  schema: z.ZodSchema<T>
): Promise<Partial<T>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
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

function resolveConnectionSaveTarget(options: {
  preferred?: ConnectionConfigSaveTarget;
  user: Partial<ConnectionConfig>;
  project: Partial<ConnectionConfig>;
}): ConnectionConfigSaveTarget {
  if (options.preferred) {
    return options.preferred;
  }

  // 连接配置通常包含敏感信息，默认优先写入 user 层，避免把密钥写回仓库目录。
  if (Object.keys(options.user).length > 0) {
    return "user";
  }

  return "user";
}
