import {
  getBuiltinPersonaPresetNames,
  resolveBuiltinPersonaPreset
} from "../../core/prompt/fragments/personaPresets.js";
import {
  normalizeModelContextWindowOverrides,
  type ModelContextWindowOverrides
} from "../../core/context/modelContextWindows.js";
import type { PermissionRuleInput } from "../../core/permissions/permissionRules.js";
import type {
  ApprovalMode,
  ApprovalModeInput,
  RuntimePaths,
  SessionSettings,
  SessionSettingsSource,
  SessionSettingsState,
  SnapshotEngine,
  SnapshotRuntimeConfig
} from "./types.js";
import {
  buildSourceMap,
  clampBoundedInt,
  clampPositiveInt,
  compactObject,
  compactObjectExcept,
  getArgValue,
  getArgValues,
  hasFlag,
  mergeLayers,
  normalizeOptionalText,
  parseOptionalBoolean,
  parseOptionalPositiveInt,
  parsePathListFromEnv,
  resolvePromptTextFromCli,
  type SourceLayer
} from "./shared.js";
import { writeJsonConfig, type SessionSettingsFile } from "./configFiles.js";
import { resolveDirectoryInput } from "./paths.js";

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

export async function saveUserSessionSettings(
  paths: RuntimePaths,
  settings: Partial<SessionSettings>
): Promise<void> {
  await writeJsonConfig(
    paths.userSettingsConfigPath,
    serializeSessionSettings(settings, paths.workspaceRoot)
  );
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

export function normalizeSessionSettingsFile(input: Partial<SessionSettingsFile>): Partial<SessionSettings> {
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

export function resolveSettingsFromEnv(env: NodeJS.ProcessEnv): Partial<SessionSettings> {
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

export async function resolveSettingsFromCli(argv: string[]): Promise<Partial<SessionSettings>> {
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
