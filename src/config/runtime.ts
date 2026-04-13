import { promises as fs, readFileSync } from "node:fs";
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
  customSystemPrompt?: string;
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

export type ApprovalMode = "manual" | "auto";

export interface SessionSettings extends PromptOverrideConfig {
  approvalMode: ApprovalMode;
  maxSteps: number;
  commandTimeoutMs: number;
  autoSummaryEnabled: boolean;
}

export interface RuntimePaths {
  workspaceRoot: string;
  alyceDirectory: string;
  connectionConfigPath: string;
  settingsConfigPath: string;
}

export interface RuntimeConfig {
  paths: RuntimePaths;
  connection: ConnectionConfig;
  settings: SessionSettings;
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
    languagePreference: z.string().optional(),
    personaPreset: z.string().optional(),
    aiPersonalityPrompt: z.string().optional(),
    customSystemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional()
  })
  .strict();

export async function loadRuntimeConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<RuntimeConfig> {
  const workspaceRoot = path.resolve(getArgValue(argv, "--cwd") || env.AGENT_WORKSPACE || ".");
  const paths = getRuntimePaths(workspaceRoot);
  const [savedConnection, savedSettings] = await Promise.all([
    readJsonConfig(paths.connectionConfigPath, ConnectionConfigFileSchema),
    readJsonConfig(paths.settingsConfigPath, SessionSettingsFileSchema)
  ]);

  const envConnection: Partial<ConnectionConfig> = {
    apiKey: env.OPENAI_API_KEY ?? "",
    baseURL: env.OPENAI_BASE_URL || undefined,
    model: env.OPENAI_MODEL || "gpt-4.1-mini"
  };
  const cliConnection = compactObject<ConnectionConfig>({
    model: getArgValue(argv, "--model") || undefined
  });

  const envSettings = resolveSettingsFromInputs(argv, env);
  const cliSettings = compactObject<SessionSettings>({
    approvalMode: hasFlag(argv, "--yolo") ? "auto" : undefined
  });

  return {
    paths,
    connection: normalizeConnectionConfig({
      ...envConnection,
      ...savedConnection,
      ...cliConnection
    }),
    settings: normalizeSessionSettings({
      ...envSettings,
      ...savedSettings,
      ...cliSettings
    }),
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
  return {
    workspaceRoot,
    alyceDirectory,
    connectionConfigPath: path.join(alyceDirectory, "config.json"),
    settingsConfigPath: path.join(alyceDirectory, "settings.json")
  };
}

export async function saveConnectionConfig(
  paths: RuntimePaths,
  connection: ConnectionConfig
): Promise<void> {
  await writeJsonConfig(paths.connectionConfigPath, {
    apiKey: connection.apiKey,
    baseURL: connection.baseURL || undefined,
    model: connection.model
  });
}

export async function saveSessionSettings(
  paths: RuntimePaths,
  settings: SessionSettings
): Promise<void> {
  await writeJsonConfig(paths.settingsConfigPath, {
    approvalMode: settings.approvalMode,
    maxSteps: settings.maxSteps,
    commandTimeoutMs: settings.commandTimeoutMs,
    autoSummaryEnabled: settings.autoSummaryEnabled,
    languagePreference: settings.languagePreference || undefined,
    personaPreset: settings.personaPreset || undefined,
    aiPersonalityPrompt: settings.aiPersonalityPrompt || undefined,
    customSystemPrompt: settings.customSystemPrompt || undefined,
    appendSystemPrompt: settings.appendSystemPrompt || undefined
  });
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

function resolvePromptText(options: {
  argv: string[];
  directFlag: string;
  fileFlag: string;
  envValue?: string;
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

  return directValue ?? options.envValue;
}

function getArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return fallback;
}

function normalizeConnectionConfig(input: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    apiKey: input.apiKey?.trim() ?? "",
    baseURL: normalizeOptionalText(input.baseURL),
    model: input.model?.trim() || "gpt-4.1-mini"
  };
}

function normalizeSessionSettings(input: Partial<SessionSettings>): SessionSettings {
  return {
    approvalMode: input.approvalMode === "auto" ? "auto" : "manual",
    maxSteps: clampPositiveInt(input.maxSteps, 8),
    commandTimeoutMs: clampPositiveInt(input.commandTimeoutMs, 120_000),
    autoSummaryEnabled: input.autoSummaryEnabled ?? true,
    languagePreference: normalizeOptionalText(input.languagePreference),
    personaPreset: resolvePersonaPreset(normalizeOptionalText(input.personaPreset)),
    aiPersonalityPrompt: normalizeOptionalText(input.aiPersonalityPrompt),
    customSystemPrompt: normalizeOptionalText(input.customSystemPrompt),
    appendSystemPrompt: normalizeOptionalText(input.appendSystemPrompt)
  };
}

function resolveSettingsFromInputs(
  argv: string[],
  env: NodeJS.ProcessEnv
): Partial<SessionSettings> {
  return {
    maxSteps: parsePositiveInt(env.AGENT_MAX_STEPS, 8),
    commandTimeoutMs: parsePositiveInt(env.AGENT_COMMAND_TIMEOUT_MS, 120_000),
    autoSummaryEnabled: parseBoolean(env.AGENT_MEMORY_AUTO_SUMMARY, true),
    languagePreference: getArgValue(argv, "--lang") || env.AGENT_LANGUAGE || undefined,
    personaPreset: resolvePersonaPreset(
      getArgValue(argv, "--persona-preset") || env.AGENT_PERSONA_PRESET || undefined
    ),
    aiPersonalityPrompt: getArgValue(argv, "--persona") || env.AGENT_AI_PERSONALITY || undefined,
    customSystemPrompt: resolvePromptText({
      argv,
      directFlag: "--system-prompt",
      fileFlag: "--system-prompt-file",
      envValue: env.AGENT_SYSTEM_PROMPT,
      label: "system prompt"
    }),
    appendSystemPrompt: resolvePromptText({
      argv,
      directFlag: "--append-system-prompt",
      fileFlag: "--append-system-prompt-file",
      envValue: env.AGENT_APPEND_SYSTEM_PROMPT,
      label: "append system prompt"
    })
  };
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

function compactObject<T extends object>(value: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as Partial<T>;
}
