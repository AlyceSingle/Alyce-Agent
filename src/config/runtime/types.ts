import type { RequestPatchOperation } from "../../core/api/requestPatch.js";
import type { ModelContextWindowOverrides } from "../../core/context/modelContextWindows.js";
import type { PermissionRuleInput } from "../../core/permissions/permissionRules.js";
import type { ProviderProfileInputMap } from "../../core/providers/registry.js";
import type { ConnectorPluginDiagnostic } from "../../core/providers/pluginConnectors.js";
import type { ProviderConnector } from "../../core/providers/providerAuth.js";
import type { ProviderProfileMap } from "../../core/providers/types.js";
import type { ProjectTrustState } from "../../core/trust/projectTrustStore.js";

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
export type ApprovalModeInput = ApprovalMode | "manual" | "auto";

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
