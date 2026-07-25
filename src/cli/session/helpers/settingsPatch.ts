import path from "node:path";
import {
  normalizeAdditionalDirectories,
  normalizeApprovalMode,
  normalizeSnapshotSettings,
  resolveDirectoryInput,
  type ConnectionConfig,
  type RuntimeConfig,
  type SessionSettings
} from "../../../config/runtime.js";
import {
  DEFAULT_CONVERSATION_COMPACTION_CONFIG,
  type ConversationCompactionConfig
} from "../../../core/conversation/conversationCompactor.js";
import { ContextBudgetService } from "../../../core/context/contextBudget.js";
import { normalizeModelContextWindowOverrides } from "../../../core/context/modelContextWindows.js";

export function createContextBudgetService(settings: SessionSettings): ContextBudgetService {
  return new ContextBudgetService({
    modelContextWindowOverrides: settings.modelContextWindowOverrides
  });
}

export function createConversationCompactionConfig(
  settings: SessionSettings
): ConversationCompactionConfig {
  return {
    ...DEFAULT_CONVERSATION_COMPACTION_CONFIG,
    timeoutMs: settings.autoCompactTimeoutMs,
    maxAutoFailures: settings.autoCompactMaxFailures
  };
}

export function createSessionMemoryConfig(
  config: RuntimeConfig,
  settings: SessionSettings
) {
  return {
    ...config.memory.sessionMemory,
    enabled: config.memory.sessionMemory.enabled && settings.sessionMemoryEnabled
  };
}

export function normalizeConnectionPatch(
  patch: Partial<ConnectionConfig>,
  current: ConnectionConfig
): Partial<ConnectionConfig> {
  const normalized: Partial<ConnectionConfig> = {};

  if ("apiKey" in patch) {
    normalized.apiKey = patch.apiKey?.trim() ?? "";
  }

  if ("baseURL" in patch) {
    normalized.baseURL = patch.baseURL?.trim() ?? "";
  }

  if ("model" in patch) {
    normalized.model = patch.model?.trim() || current.model;
  }

  return normalized;
}

export function normalizeSettingsPatch(
  patch: Partial<SessionSettings>,
  workspaceRoot: string
): Partial<SessionSettings> {
  const normalized: Partial<SessionSettings> = {};

  if ("uiLanguage" in patch) {
    normalized.uiLanguage = patch.uiLanguage === "zh" ? "zh" : "en";
  }

  if ("approvalMode" in patch) {
    normalized.approvalMode = normalizeApprovalMode(patch.approvalMode);
  }

  if ("maxSteps" in patch && patch.maxSteps !== undefined) {
    normalized.maxSteps = Math.max(1, Math.trunc(patch.maxSteps));
  }

  if ("commandTimeoutMs" in patch && patch.commandTimeoutMs !== undefined) {
    normalized.commandTimeoutMs = Math.max(1, Math.trunc(patch.commandTimeoutMs));
  }

  if ("scrollSpeed" in patch && patch.scrollSpeed !== undefined) {
    normalized.scrollSpeed = Math.min(8, Math.max(1, Math.trunc(patch.scrollSpeed)));
  }

  if ("scrollAccelerationEnabled" in patch) {
    normalized.scrollAccelerationEnabled = patch.scrollAccelerationEnabled;
  }

  if ("historyPagingEnabled" in patch) {
    normalized.historyPagingEnabled = patch.historyPagingEnabled;
  }

  if (
    "maxMessagesWithoutVirtualization" in patch &&
    patch.maxMessagesWithoutVirtualization !== undefined
  ) {
    normalized.maxMessagesWithoutVirtualization = Math.max(
      1,
      Math.trunc(patch.maxMessagesWithoutVirtualization)
    );
  }

  if ("sessionMemoryEnabled" in patch) {
    normalized.sessionMemoryEnabled = patch.sessionMemoryEnabled;
  }

  if ("messageTimestampsEnabled" in patch) {
    normalized.messageTimestampsEnabled = patch.messageTimestampsEnabled;
  }
  // UI 消息时钟开关；与 messageTimestampsEnabled（API 系统时间）相互独立。
  if ("showMessageTimestamps" in patch) {
    normalized.showMessageTimestamps = patch.showMessageTimestamps;
  }

  if ("markdownMessageRenderingEnabled" in patch) {
    normalized.markdownMessageRenderingEnabled = patch.markdownMessageRenderingEnabled;
  }

  if ("markdownToolMessageRenderingEnabled" in patch) {
    normalized.markdownToolMessageRenderingEnabled = patch.markdownToolMessageRenderingEnabled;
  }

  if ("markdownRenderMaxChars" in patch && patch.markdownRenderMaxChars !== undefined) {
    normalized.markdownRenderMaxChars = Math.max(1, Math.trunc(patch.markdownRenderMaxChars));
  }

  if ("snapshot" in patch) {
    normalized.snapshot = normalizeSnapshotSettings(patch.snapshot);
  }

  if ("conversationCompactionEnabled" in patch) {
    normalized.conversationCompactionEnabled = patch.conversationCompactionEnabled;
  }

  if ("autoCompactTimeoutMs" in patch) {
    normalized.autoCompactTimeoutMs = clampPositiveInt(patch.autoCompactTimeoutMs, 180_000);
  }

  if ("autoCompactMaxFailures" in patch) {
    normalized.autoCompactMaxFailures = clampPositiveInt(patch.autoCompactMaxFailures, 3);
  }

  if ("modelContextWindowOverrides" in patch) {
    normalized.modelContextWindowOverrides = normalizeModelContextWindowOverrides(
      patch.modelContextWindowOverrides
    );
  }

  if ("languagePreference" in patch) {
    normalized.languagePreference = normalizeOptionalSessionTextPatch(patch.languagePreference);
  }

  if ("personaPreset" in patch) {
    normalized.personaPreset = normalizeOptionalSessionTextPatch(patch.personaPreset);
  }

  if ("aiPersonalityPrompt" in patch) {
    normalized.aiPersonalityPrompt = normalizeOptionalSessionTextPatch(patch.aiPersonalityPrompt);
  }

  if ("appendSystemPrompt" in patch) {
    normalized.appendSystemPrompt = normalizeOptionalSessionTextPatch(patch.appendSystemPrompt);
  }

  if ("additionalDirectories" in patch) {
    normalized.additionalDirectories = normalizeAdditionalDirectories(
      patch.additionalDirectories,
      workspaceRoot
    );
  }

  if ("permissionRules" in patch) {
    normalized.permissionRules = patch.permissionRules ?? [];
  }

  return normalized;
}

function normalizeOptionalSessionTextPatch(value: string | undefined): string {
  // 空字符串用于保留"显式清空"语义，避免删除用户层键后回退到项目默认。
  if (value === undefined) {
    return "";
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "";
}

export function isFileBackupSnapshotEnabled(settings: SessionSettings): boolean {
  if (!settings.snapshot.enabled) {
    return false;
  }

  if (settings.snapshot.engine === "file-backup") {
    return true;
  }

  return settings.snapshot.engine === "hybrid" &&
    settings.snapshot.includeIgnoredExplicitPaths;
}

export function resolveAllowedRoots(
  workspaceRoot: string,
  settings: SessionSettings,
  sessionAdditionalDirectories: readonly string[]
): string[] {
  const deduped = new Set<string>([path.resolve(workspaceRoot)]);
  for (const directory of settings.additionalDirectories) {
    deduped.add(resolveDirectoryInput(directory, workspaceRoot));
  }
  for (const directory of sessionAdditionalDirectories) {
    deduped.add(resolveDirectoryInput(directory, workspaceRoot));
  }

  return [...deduped];
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value!));
}
