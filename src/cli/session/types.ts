import type OpenAI from "openai";
import type {
  ConnectionConfig,
  ConnectionConfigSaveTarget,
  ConnectionConfigState,
  RuntimeConfig,
  SessionSettings,
  SessionSettingsState
} from "../../config/runtime.js";
import type { ConversationCompactionState } from "../../core/conversation/conversationCompactor.js";
import type { ContextBudgetService, ContextBudgetSnapshot } from "../../core/context/contextBudget.js";
import type { ProviderAuthMap } from "../../core/auth/authStore.js";
import type {
  BackgroundProcessRecord,
  BackgroundProcessStopOptions,
  BackgroundProcessStopResult
} from "../../core/background-process/backgroundProcessTypes.js";
import type { PtyCloseResult, PtySessionInfo } from "../../core/pty/ptyTypes.js";
import type { PlanModeState } from "../../core/planMode/planMode.js";
import type { MemoryService } from "../../core/memory/memoryService.js";
import type { SessionMemoryExtractorState } from "../../core/memory/sessionMemoryExtractor.js";
import type { SessionMemoryTriggerState } from "../../core/memory/sessionMemoryTrigger.js";
import type { FileHistoryRestoreResult } from "../../core/file-history/fileHistoryManager.js";
import type { SnapshotDiagnostics } from "../../core/snapshot/turnSnapshotService.js";
import type {
  DiffReport,
  TurnDiffReport,
  WorkingTreeDiffReport
} from "../../core/diff/diffService.js";
import type {
  MemoryVolatileSnapshot,
  SessionMemoryFileState
} from "../../core/memory/types.js";
import type {
  ChatCompletionAdapter,
  ChatCompletionTransport
} from "../../core/api/modelAdapters.js";
import type { ModelRef, ResolvedModelProfile } from "../../core/providers/types.js";
import type { AuthFlow } from "../../core/providers/providerAuth.js";
import type { ProviderModelRefreshResult } from "../../core/providers/modelDiscovery.js";
import type { AgentQuerySource } from "../../core/agent/querySource.js";
import type { UsageRecordInput } from "../../core/usage/types.js";
import type {
  SessionHistoryListItem,
  SessionHistoryRewindMode,
  SessionHistorySubagentEvent,
  SessionHistoryUiMessage,
  SessionId,
  SessionResumePayload
} from "../../core/session-history/types.js";
import type { SubagentStorageCleanupReport } from "../../core/subagent-history/storageCleanup.js";
import type { ProjectTrustState } from "../../core/trust/projectTrustStore.js";
import type {
  McpConfigMutationResult,
  McpConfigScope,
  McpElicitationCompleteEvent,
  McpElicitationRequest,
  McpElicitationResponse,
  McpListPromptsResult,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpListToolsResult,
  McpLoginResult,
  McpPromptResult,
  McpServerConfig,
  McpStatusResult
} from "../../mcp/types.js";
import type {
  SkillActivationContext,
  SkillCatalog,
  SkillConfigMutationResult,
  SkillDescriptor,
  SkillReference
} from "../../skills/service.js";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  FileReadState,
  SubagentRunInput,
  SubagentRunResult,
  SubagentTaskInfo,
  SubagentTaskLaunchResult,
  SubagentTaskStopResult,
  TodoItem,
  ToolApprovalRequest,
  ToolExecutionContext
} from "../../tools/types.js";
import type { ProviderConnectionPlan } from "../connectCommand.js";
export type { PreparedPromptSkillContext } from "./promptRuntime.js";
import type { PreparedPromptSkillContext } from "./promptRuntime.js";

export type SessionMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type FileReadStateSnapshot = Map<string, FileReadState>;

export interface VolatileConversationSnapshot {
  messages: SessionMessage[];
  fileReadState: FileReadStateSnapshot;
  memory: MemoryVolatileSnapshot;
  compaction: ConversationCompactionState | null;
  sessionMemoryTrigger: SessionMemoryTriggerState | null;
  sessionMemoryExtractor: SessionMemoryExtractorState | null;
}

export interface SessionRuntime {
  config: RuntimeConfig;
  memoryService: MemoryService;
  messages: SessionMessage[];
  workspaceRoot: string;
  requestPatches: RuntimeConfig["requestPatches"];
  getMainAgentToolSchemas: (
    options?: { abortSignal?: AbortSignal }
  ) => Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  getSessionId: () => SessionId;
  getSessionHistoryDirectory: () => string;
  hasConnectionConfig: () => boolean;
  getConnectionConfig: () => ConnectionConfig;
  getConnectionConfigState: () => ConnectionConfigState;
  getProviderAuthRecords: () => ProviderAuthMap;
  getAuthStorePath: () => string;
  getSettings: () => SessionSettings;
  getSettingsState: () => SessionSettingsState;
  getProjectTrustState: () => ProjectTrustState;
  setProjectTrusted: (trusted: boolean) => Promise<ProjectTrustState>;
  getPlanModeState: () => PlanModeState;
  setPlanModeEnabled: (enabled: boolean) => Promise<PlanModeState>;
  requireChatCompletionAdapter: () => ChatCompletionAdapter;
  getCurrentModel: () => string;
  getCurrentModelRef: () => ModelRef;
  getResolvedModelProfile: () => ResolvedModelProfile;
  refreshCurrentProviderModels: () => Promise<ProviderModelRefreshResult>;
  setCurrentModel: (model: string) => Promise<void>;
  updateConnectionConfig: (
    patch: Partial<ConnectionConfig>,
    target?: ConnectionConfigSaveTarget
  ) => Promise<void>;
  applyProviderConnection: (plan: ProviderConnectionPlan) => Promise<void>;
  authorizeProviderAuth: (
    providerId: string,
    methodIndex: number,
    inputs?: Record<string, string>
  ) => Promise<
    | { type: "stored"; providerId: string; model: string }
    | { type: "flow"; flow: AuthFlow }
  >;
  completeProviderAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
    options?: { signal?: AbortSignal }
  ) => Promise<{ providerId: string; model: string }>;
  clearProviderAuthFlow: (providerId?: string) => void;
  removeProviderAuth: (providerId: string) => Promise<boolean>;
  updateSettings: (patch: Partial<SessionSettings>) => Promise<void>;
  getAllowedRoots: () => string[];
  getSessionAdditionalDirectories: () => string[];
  setSessionAdditionalDirectories: (directories: string[]) => Promise<void>;
  resetSystemMessage: (options?: {
    availableTools?: string[];
    skillActivationContext?: SkillActivationContext;
    nextUserInput?: string;
  }) => Promise<void>;
  clearConversation: () => Promise<void>;
  clearPromptCache: () => void;
  recordSessionTurn: (options: {
    apiMessages: SessionMessage[];
    uiMessages: SessionHistoryUiMessage[];
  }) => Promise<void>;
  recordSessionConversationSnapshot: (options: {
    apiMessages: SessionMessage[];
    uiMessages: SessionHistoryUiMessage[];
    uiBaseMessageCount: number;
  }) => Promise<void>;
  recordSessionMemory: (sessionMemory?: SessionMemoryFileState | null) => Promise<void>;
  recordSessionSubagentEvent: (event: SessionHistorySubagentEvent) => Promise<void>;
  recordSessionRewind: (options: {
    apiMessageCount: number;
    uiMessageCount: number;
    sessionMemory?: SessionMemoryFileState | null;
    restoredInput?: string;
    restoreMode?: SessionHistoryRewindMode;
  }) => Promise<void>;
  flushSessionHistory: () => Promise<void>;
  listSessionHistory: (options?: {
    limit?: number;
    excludeCurrent?: boolean;
  }) => Promise<SessionHistoryListItem[]>;
  findSessionHistory: (query: string, options?: {
    excludeCurrent?: boolean;
  }) => Promise<SessionHistoryListItem[]>;
  resumeSessionHistory: (sessionId: SessionId) => Promise<SessionResumePayload>;
  listSubagentTasks: () => SubagentTaskInfo[];
  getSubagentTask: (taskId: string) => Promise<SubagentTaskInfo | undefined>;
  stopSubagentTask: (taskId: string) => Promise<SubagentTaskStopResult>;
  runSubagent: (
    input: SubagentRunInput,
    parentContextOptions: Parameters<SessionRuntime["createToolContext"]>[0]
  ) => Promise<SubagentRunResult>;
  runSubagentStorageCleanup: (options?: { apply?: boolean }) => Promise<SubagentStorageCleanupReport>;
  listBackgroundProcesses: (options?: { includeExited?: boolean }) => BackgroundProcessRecord[];
  stopBackgroundProcess: (
    processId: string,
    options?: BackgroundProcessStopOptions
  ) => Promise<BackgroundProcessStopResult>;
  stopAllBackgroundProcesses: (
    options?: BackgroundProcessStopOptions
  ) => Promise<BackgroundProcessStopResult[]>;
  listPtySessions: () => PtySessionInfo[];
  closeAllPtySessions: () => PtyCloseResult[];
  buildContextPreview: (nextUserInput?: string, options?: { abortSignal?: AbortSignal }) => Promise<string>;
  listSkills: () => Promise<SkillCatalog>;
  getSkill: (name: string) => Promise<SkillDescriptor | undefined>;
  setSkillEnabled: (
    reference: SkillReference,
    enabled: boolean,
    target: "project" | "user"
  ) => Promise<SkillConfigMutationResult>;
  setBundledSkillsEnabled: (
    enabled: boolean,
    target: "project" | "user"
  ) => Promise<SkillConfigMutationResult>;
  refreshSkills: () => Promise<SkillCatalog>;
  getMcpStatus: (options?: {
    abortSignal?: AbortSignal;
    initialize?: boolean;
  }) => Promise<McpStatusResult>;
  listMcpTools: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
  }) => Promise<McpListToolsResult>;
  listMcpResources: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<McpListResourcesResult>;
  listMcpPrompts: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<McpListPromptsResult>;
  getMcpPrompt: (
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
    options?: {
      maxTextChars?: number;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
    }
  ) => Promise<McpPromptResult>;
  listMcpResourceTemplates: (options?: {
    serverName?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<McpListResourceTemplatesResult>;
  addMcpServer: (
    name: string,
    config: McpServerConfig,
    scope?: McpConfigScope
  ) => Promise<McpConfigMutationResult>;
  removeMcpServer: (
    name: string,
    scope?: McpConfigScope
  ) => Promise<McpConfigMutationResult>;
  setMcpServerEnabled: (
    name: string,
    enabled: boolean,
    scope?: McpConfigScope
  ) => Promise<McpConfigMutationResult>;
  loginMcpServer: (
    serverName: string,
    options?: {
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      onAuthorizationUrl?: (details: {
        server: string;
        authorizationUrl: string;
        redirectUrl: string;
      }) => void;
    }
  ) => Promise<McpLoginResult>;
  setMcpInteractionHandlers: (handlers: {
    requestElicitation?: (
      request: McpElicitationRequest,
      options?: { signal?: AbortSignal; timeoutMs?: number }
    ) => Promise<McpElicitationResponse>;
    onElicitationComplete?: (event: McpElicitationCompleteEvent) => void;
  }) => void;
  preparePromptSkillContext: (input: string) => Promise<PreparedPromptSkillContext>;
  getContextBudgetService: () => ContextBudgetService;
  estimateContextBudget: (options?: {
    messages?: SessionMessage[];
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
    model?: string;
    resolvedModel?: ResolvedModelProfile;
  }) => Promise<ContextBudgetSnapshot>;
  recordUsage: (event: UsageRecordInput) => void;
  formatUsageReport: () => string;
  maybeCompactConversation: (options: {
    client: ChatCompletionTransport;
    model: string;
    resolvedModel?: ResolvedModelProfile;
    force?: boolean;
    querySource?: AgentQuerySource;
    usageTurnId?: string;
    abortSignal?: AbortSignal;
  }) => Promise<boolean>;
  scheduleSessionMemoryExtraction: (options: {
    client: ChatCompletionTransport;
    model: string;
    resolvedModel?: ResolvedModelProfile;
    querySource?: AgentQuerySource;
    usageTurnId?: string;
    abortSignal?: AbortSignal;
  }) => void;
  createVolatileConversationSnapshot: () => VolatileConversationSnapshot;
  restoreVolatileConversationSnapshot: (snapshot: VolatileConversationSnapshot) => Promise<void>;
  beginTurn: (turnId: string) => Promise<void>;
  finalizeTurnFileChanges: (turnId: string) => Promise<void>;
  hasTrackedFileChanges: (turnId: string) => boolean;
  canRestoreFilesForTurn: (turnId: string) => boolean;
  isFilesAlreadyRestoredForTurn: (turnId: string) => boolean;
  restoreFilesForTurn: (turnId: string) => Promise<FileHistoryRestoreResult>;
  discardTurn: (turnId: string) => void;
  getTurnDiff: (turnId: string) => Promise<TurnDiffReport>;
  getLastAlyceTurnDiff: () => Promise<TurnDiffReport | undefined>;
  getWorkingTreeDiff: () => Promise<WorkingTreeDiffReport>;
  getSnapshotDiagnostics: () => Promise<SnapshotDiagnostics>;
  formatDiffSummary: (report: DiffReport) => string;
  createToolContext: (options: {
    turnId: string;
    abortSignal: AbortSignal;
    requestApproval: (
      request: ToolApprovalRequest,
      options?: { signal?: AbortSignal }
    ) => Promise<boolean>;
    askUserQuestions: (
      request: AskUserQuestionRequest,
      options?: { signal?: AbortSignal }
    ) => Promise<AskUserQuestionResponse>;
    getTodos: () => TodoItem[];
    setTodos: (todos: TodoItem[]) => void;
    recordToolActivity?: (toolName: string) => void;
  }) => ToolExecutionContext;
}

