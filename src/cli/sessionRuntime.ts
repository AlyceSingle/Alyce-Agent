import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import {
  buildConnectionConfigState,
  buildSessionSettingsState,
  loadRuntimeConfig,
  normalizeAdditionalDirectories,
  resolveDirectoryInput,
  saveConnectionConfig,
  saveUserSessionSettings,
  type ConnectionConfig,
  type ConnectionConfigSaveTarget,
  type ConnectionConfigState,
  type RuntimeConfig,
  type SessionSettings,
  type SessionSettingsState
} from "../config/runtime.js";
import {
  ConversationCompactor,
  DEFAULT_CONVERSATION_COMPACTION_CONFIG,
  type ConversationCompactionConfig,
  type ConversationCompactionState
} from "../core/conversation/conversationCompactor.js";
import {
  ContextBudgetService,
  type ContextBudgetSnapshot
} from "../core/context/contextBudget.js";
import { normalizeModelContextWindowOverrides } from "../core/context/modelContextWindows.js";
import { MemoryService } from "../core/memory/memoryService.js";
import {
  SessionMemoryExtractor,
  type SessionMemoryExtractorState
} from "../core/memory/sessionMemoryExtractor.js";
import {
  SessionMemoryTrigger,
  type SessionMemoryTriggerState
} from "../core/memory/sessionMemoryTrigger.js";
import { FileHistoryManager, type FileHistoryRestoreResult } from "../core/file-history/fileHistoryManager.js";
import { isTurnInterruptedError, throwIfAborted, TurnInterruptedError } from "../core/abort.js";
import type {
  MemorySnapshot,
  MemoryVolatileSnapshot,
  SessionMemoryFileState
} from "../core/memory/types.js";
import { buildPatchedChatCompletionRequest } from "../core/api/sendChatCompletion.js";
import { cloneJson } from "../core/json/clone.js";
import { buildEffectiveSystemPrompt } from "../core/prompt/builder.js";
import { PromptSectionResolver } from "../core/prompt/sectionResolver.js";
import { runAgentTurn } from "../core/agent/runAgentTurn.js";
import type { AgentQuerySource } from "../core/agent/querySource.js";
import { prepareSessionResume } from "../core/session-history/sessionResume.js";
import { SessionHistoryStore } from "../core/session-history/sessionStorage.js";
import type {
  SessionHistoryListItem,
  SessionHistoryRewindMode,
  SessionHistorySubagentEvent,
  SessionHistorySubagentTaskIndexItem,
  SessionHistoryUiMessage,
  SessionId,
  SessionResumePayload
} from "../core/session-history/types.js";
import { SubagentHistoryStore } from "../core/subagent-history/historyStore.js";
import { migrateLegacySubagentTasks } from "../core/subagent-history/legacyMigration.js";
import {
  cleanupSubagentStorageArtifacts,
  type SubagentStorageCleanupReport
} from "../core/subagent-history/storageCleanup.js";
import { SubagentTaskStorage } from "../core/subagent-history/storagePaths.js";
import {
  SUBAGENT_METADATA_VERSION,
  type SubagentMetadataV1,
  type SubagentTranscriptEntry,
  type SubagentTranscriptToolEvent
} from "../core/subagent-history/types.js";
import { formatCurrentDateLabel, formatSystemDateTime, getSystemTimeZone } from "../core/time/systemTime.js";
import { createProjectMcpRuntime } from "../mcp/runtime.js";
import { getRegisteredToolNames, getToolSchemasByName } from "../tools/registry.js";
import { TOOL_SCHEMAS } from "../tools.js";
import {
  loadSubagentDefinition,
  loadSubagentDefinitions,
  type SubagentDefinition
} from "../tools/AgentTool/agents.js";
import { isToolSchemaAllowedByPolicy } from "../tools/toolPolicy.js";
import { isKnownToolName } from "../tools/toolNames.js";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  FileReadState,
  SubagentProgressEvent,
  SubagentTaskInfo,
  SubagentTaskLaunchResult,
  SubagentTaskStatus,
  SubagentTaskStopResult,
  SubagentRunInput,
  SubagentRunResult,
  TodoItem,
  ToolApprovalRequest,
  ToolExecutionContext
} from "../tools/types.js";
import { buildNextTurnContextPreview } from "./contextPreview.js";
import { resolveSubagentAllowedRoots } from "./subagentAllowedRoots.js";
import {
  MAX_SUBAGENT_PROGRESS_DETAIL_CHARS,
  MAX_SUBAGENT_PROGRESS_EVENTS,
  MAX_SUBAGENT_PROGRESS_MESSAGE_CHARS,
  truncateProgressText
} from "./subagentProgress.js";
import { prepareResumableSubagentMessages } from "./subagentResumeMessages.js";

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

interface SubagentSession {
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  parentSessionId: SessionId;
  transcriptPath: string;
  metadataPath: string;
  outputPath: string;
  createdAt: string;
  updatedAt: string;
  status: SubagentTaskInfo["status"];
  startedAt?: string;
  completedAt?: string;
  evictAfter?: number;
  output?: string;
  error?: string;
  controller?: AbortController;
  promise?: Promise<void>;
  runToken?: string;
  isolateWorktree?: boolean;
  activeWorktreePath?: string;
  progress: SubagentProgressEvent[];
  worktreePath?: string;
  diffSummary?: string;
  hasChanges?: boolean;
  baseWorkspaceRoot?: string;
  messages: SessionMessage[];
  transcriptSyncedMessageCount: number;
  contextBudgetService: ContextBudgetService;
  conversationCompactor: ConversationCompactor;
}

interface PromptRuntimeContextOptions {
  availableTools?: string[];
  workspaceRoot?: string;
  allowedRoots?: string[];
  model?: string;
}

interface SubagentPromptInput {
  agentType: string;
  description: string;
  model?: string;
}

// SessionRuntime 统一封装会话消息、持久化配置、记忆系统和工具执行依赖。
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
  getSettings: () => SessionSettings;
  getSettingsState: () => SessionSettingsState;
  requireClient: () => OpenAI;
  getCurrentModel: () => string;
  setCurrentModel: (model: string) => Promise<void>;
  updateConnectionConfig: (
    patch: Partial<ConnectionConfig>,
    target?: ConnectionConfigSaveTarget
  ) => Promise<void>;
  updateSettings: (patch: Partial<SessionSettings>) => Promise<void>;
  getAllowedRoots: () => string[];
  getSessionAdditionalDirectories: () => string[];
  setSessionAdditionalDirectories: (directories: string[]) => Promise<void>;
  resetSystemMessage: (options?: { availableTools?: string[] }) => Promise<void>;
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
  runSubagentStorageCleanup: (options?: { apply?: boolean }) => Promise<SubagentStorageCleanupReport>;
  buildContextPreview: (nextUserInput?: string, options?: { abortSignal?: AbortSignal }) => Promise<string>;
  getContextBudgetService: () => ContextBudgetService;
  estimateContextBudget: (options?: {
    messages?: SessionMessage[];
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
    model?: string;
    gcliGeminiCompat?: boolean;
  }) => ContextBudgetSnapshot;
  maybeCompactConversation: (options: {
    client: OpenAI;
    model: string;
    force?: boolean;
    querySource?: AgentQuerySource;
    abortSignal?: AbortSignal;
  }) => Promise<boolean>;
  scheduleSessionMemoryExtraction: (options: {
    client: OpenAI;
    model: string;
    querySource?: AgentQuerySource;
    abortSignal?: AbortSignal;
  }) => void;
  createVolatileConversationSnapshot: () => VolatileConversationSnapshot;
  restoreVolatileConversationSnapshot: (snapshot: VolatileConversationSnapshot) => Promise<void>;
  beginTurn: (turnId: string) => void;
  hasTrackedFileChanges: (turnId: string) => boolean;
  restoreFilesForTurn: (turnId: string) => Promise<FileHistoryRestoreResult>;
  discardTurn: (turnId: string) => void;
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

const SUBAGENT_TERMINAL_MEMORY_RETENTION_MS = 30_000;
const SUBAGENT_MEMORY_GC_INTERVAL_MS = 5_000;
const HISTORICAL_SUBAGENT_RUNNING_ERROR = "Task is not running in this process.";

function getCurrentDateLabel(now = new Date()) {
  // 不用 UTC 截日，避免本地时间接近零点时把 prompt 里的日期算错一天。
  return formatCurrentDateLabel(now);
}

export function getHelpText(currentModel: string) {
  return [
    "Commands:",
    "  /help              Show this help",
    "  /settings          Open runtime settings",
    "  /setup             Open connection setup",
    "  /clear             Clear chat history",
    "  /rewind            Restore to a previous prompt",
    "  /resume [id|text]  Resume a previous project session",
    "  /sessions          List saved project sessions",
    "  /remember <text>   Save note to session and persistent memory",
    "  /remember --session <text>  Save note to session notes only",
    "  /memory            Show memory snapshot",
    "  /memory clear      Clear session memory",
    "  /memory clear --all  Clear session and persistent memory",
    "  /tasks cleanup [--apply]  Scan or clean stale subagent storage artifacts",
    "  /context [text]    Show full next-turn AI context payload",
    "  /model <name>      Switch model and persist it (current: " + currentModel + ")",
    "  /exit              Quit",
    "",
    "Shortcuts:",
    "  Ctrl+X  Open settings",
    "  Esc     Interrupt while running; when idle, open rewind from empty input",
    "  Ctrl+C  Copy selection, otherwise clear input, otherwise quit",
    "  Ctrl+Q  Quit"
  ].join("\n");
}

export function formatMemorySnapshot(snapshot: MemorySnapshot, persistentPath: string) {
  const lines: string[] = ["=== Memory Snapshot ===", "Persistent file: " + persistentPath];

  lines.push("Session memory source: " + snapshot.sessionMemoryPath);
  if (!snapshot.sessionMemoryEnabled) {
    lines.push("Session memory summary: (disabled)");
  } else if (!snapshot.sessionMemory) {
    lines.push("Session memory summary: (not initialized yet)");
  } else {
    lines.push(
      "Session memory summary" +
        (snapshot.sessionMemory.updatedAt ? " (updated at " + snapshot.sessionMemory.updatedAt + ")" : "") +
        ":"
    );
    lines.push(snapshot.sessionMemory.markdown);
  }

  if (snapshot.session.length === 0) {
    lines.push("Session notes: (empty)");
  } else {
    lines.push("Session notes:");
    for (const entry of snapshot.session) {
      lines.push(`- [${entry.createdAt.slice(0, 10)}] (${entry.source}) ${entry.content}`);
    }
  }

  if (snapshot.persistent.length === 0) {
    lines.push("Persistent memory: (empty)");
  } else {
    lines.push("Persistent memory:");
    for (const entry of snapshot.persistent) {
      lines.push(`- [${entry.createdAt.slice(0, 10)}] (${entry.source}) ${entry.content}`);
    }
  }

  lines.push("=== End Memory Snapshot ===");
  return lines.join("\n");
}

export async function createSessionRuntime(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<SessionRuntime> {
  const config = await loadRuntimeConfig(argv, env);
  // 运行时维护一份可变快照，避免直接在初始配置对象上原地修改。
  let connectionState = cloneConnectionConfigState(config.connectionState);
  let settingsState = cloneSessionSettingsState(config.settingsState);
  let connection = connectionState.effective;
  let settings = settingsState.effective;
  let sessionAdditionalDirectories: string[] = [];
  let connectionSaveTarget = connectionState.saveTarget;
  let client: OpenAI | null = createClientFromConnection(connection);

  const promptResolver = new PromptSectionResolver();
  const fileHistoryManager = new FileHistoryManager();
  const conversationCompactor = new ConversationCompactor(
    createConversationCompactionConfig(settings)
  );
  const contextBudgetService = createContextBudgetService(settings);
  const sessionMemoryTrigger = new SessionMemoryTrigger(
    createSessionMemoryTriggerConfig(config, settings)
  );
  const sessionMemoryExtractor = new SessionMemoryExtractor(
    createSessionMemoryExtractorConfig(config, settings)
  );
  const sessionHistory = new SessionHistoryStore({
    sessionsDirectory: path.join(config.paths.alyceDirectory, "sessions"),
    workspaceRoot: config.paths.workspaceRoot
  });
  const getSessionMemorySourcePath = () =>
    "session history: " +
    path.relative(config.paths.workspaceRoot, sessionHistory.getCurrentSessionFilePath());
  const memoryService = new MemoryService({
    workspaceRoot: config.paths.workspaceRoot,
    ...config.memory
  });
  memoryService.setSessionMemoryEnabled(settings.sessionMemoryEnabled);
  memoryService.setSessionMemorySourcePath(getSessionMemorySourcePath());
  await memoryService.initialize();
  const mcpRuntime = await createProjectMcpRuntime(config.paths.workspaceRoot);
  const fileReadState = new Map<string, FileReadState>();
  const subagentSessions = new Map<string, SubagentSession>();
  // 只缓存“当前主会话”的轻量任务索引，用于 TaskList/TaskGet 的跨重启恢复。
  const currentSessionTaskIndex = new Map<string, SessionHistorySubagentTaskIndexItem>();
  const subagentTaskStorage = new SubagentTaskStorage({
    alyceDirectory: config.paths.alyceDirectory,
    getCurrentSessionId: () => sessionHistory.getCurrentSessionId()
  });
  const subagentHistoryStore = new SubagentHistoryStore();
  const getWorktreesDirectory = () =>
    path.join(os.tmpdir(), "alyce-agent-worktrees", sessionHistory.getCurrentSessionId());
  await migrateLegacySubagentTasks({
    storage: subagentTaskStorage,
    historyStore: subagentHistoryStore
  }).catch(() => undefined);
  const subagentMemoryGcTimer = setInterval(
    () => {
      evictExpiredSubagentSessionsFromMemory();
    },
    SUBAGENT_MEMORY_GC_INTERVAL_MS
  );
  subagentMemoryGcTimer.unref?.();

  const getAllowedRootsSnapshot = () =>
    resolveAllowedRoots(config.paths.workspaceRoot, settings, sessionAdditionalDirectories);

  const getMainAgentToolSchemas = async (options: { abortSignal?: AbortSignal } = {}) => [
    ...TOOL_SCHEMAS,
    ...await mcpRuntime.getToolSchemas({
      abortSignal: options.abortSignal,
      initialize: false
    })
  ];

  const getToolNamesFromSchemas = (
    tools: OpenAI.Chat.Completions.ChatCompletionTool[]
  ) => tools.map((tool) => tool.function.name).sort((left, right) => left.localeCompare(right));

  const getAvailableToolNamesForPrompt = (availableTools?: string[]) =>
    availableTools ?? getRegisteredToolNames();

  const getPromptRuntimeContext = async (options: PromptRuntimeContextOptions = {}) => {
    const now = new Date();
    const workspaceRoot = options.workspaceRoot ?? config.paths.workspaceRoot;
    return {
      model: options.model ?? connection.model,
      workspaceRoot,
      allowedRoots: options.allowedRoots ?? resolveAllowedRoots(
        workspaceRoot,
        settings,
        sessionAdditionalDirectories
      ),
      currentDate: getCurrentDateLabel(now),
      currentDateTime: formatSystemDateTime(now),
      timeZone: getSystemTimeZone(),
      platform: process.platform,
      availableTools: getAvailableToolNamesForPrompt(options.availableTools),
      memory: await memoryService.getPromptContext()
    };
  };

  // system prompt 始终由当前模型、环境、工具能力和记忆视图重新生成。
  const buildSystemPrompt = async (options: { availableTools?: string[] } = {}) =>
    buildEffectiveSystemPrompt(
      await getPromptRuntimeContext(options),
      settings,
      promptResolver
    );

  const buildSubagentSystemPrompt = async (
    input: SubagentPromptInput,
    workspaceRoot = config.paths.workspaceRoot
  ) => {
    const agent = await loadSubagentDefinition(config.paths.workspaceRoot, input.agentType);
    if (!agent) {
      throw new Error(`Unknown subagent type: ${input.agentType}`);
    }

    const resolver = new PromptSectionResolver();
    const allowedRoots = resolveSubagentAllowedRoots(
      workspaceRoot,
      agent,
      settings,
      sessionAdditionalDirectories
    );
    const basePrompt = await buildEffectiveSystemPrompt(
      await getPromptRuntimeContext({
        availableTools: getAllowedToolNamesForSubagent(agent),
        workspaceRoot,
        allowedRoots,
        model: input.model
      }),
      {
        ...settings,
        appendSystemPrompt: [
          agent.systemPrompt,
          settings.appendSystemPrompt?.trim() ? settings.appendSystemPrompt.trim() : ""
        ].filter(Boolean).join("\n\n")
      },
      resolver
    );

    return [
      basePrompt,
      "# Subagent assignment",
      `Subagent type: ${agent.type}`,
      `Task description: ${input.description}`,
      "Return one final report to the parent agent. Do not ask the user directly unless an available question tool is necessary."
    ].join("\n\n");
  };

  const messages: SessionMessage[] = [
    {
      role: "system",
      content: await buildSystemPrompt()
    }
  ];

  // 约定 messages[0] 永远保留为 system message，其他消息只追加在其后。
  const resetSystemMessage = async (options: { availableTools?: string[] } = {}) => {
    messages[0] = {
      role: "system",
      content: await buildSystemPrompt(options)
    };
  };

  const resetVolatileConversationState = async () => {
    abortRunningSubagentTasks();
    await memoryService.clearSession();
    conversationCompactor.clear();
    promptResolver.clearSessionCache();
    fileHistoryManager.clearAll();
    fileReadState.clear();
    sessionAdditionalDirectories = [];
    sessionMemoryTrigger.clear();
    sessionMemoryExtractor.clear();
    evictExpiredSubagentSessionsFromMemory();
  };

  const createFileReadStateSnapshot = (): FileReadStateSnapshot =>
    new Map(
      [...fileReadState.entries()].map(([absolutePath, state]) => [
        absolutePath,
        { ...state }
      ])
    );

  const restoreFileReadStateSnapshot = (snapshot: FileReadStateSnapshot) => {
    fileReadState.clear();
    for (const [absolutePath, state] of snapshot.entries()) {
      fileReadState.set(absolutePath, { ...state });
    }
  };

  const createVolatileConversationSnapshot = (): VolatileConversationSnapshot => ({
    messages: cloneJson(messages),
    fileReadState: createFileReadStateSnapshot(),
    memory: memoryService.createVolatileSnapshot(),
    compaction: conversationCompactor.createSnapshot(),
    sessionMemoryTrigger: sessionMemoryTrigger.createSnapshot(),
    sessionMemoryExtractor: sessionMemoryExtractor.createSnapshot()
  });

  const restoreVolatileConversationSnapshot = async (snapshot: VolatileConversationSnapshot) => {
    messages.splice(0, messages.length, ...cloneJson(snapshot.messages));
    restoreFileReadStateSnapshot(snapshot.fileReadState);
    memoryService.restoreVolatileSnapshot(snapshot.memory);
    conversationCompactor.restoreSnapshot(snapshot.compaction);
    sessionMemoryTrigger.restoreSnapshot(snapshot.sessionMemoryTrigger);
    sessionMemoryExtractor.restoreSnapshot(snapshot.sessionMemoryExtractor);
    promptResolver.clearSessionCache();
    await resetSystemMessage();
  };

  const rebuildConnectionState = (options: {
    user?: Partial<ConnectionConfig>;
    project?: Partial<ConnectionConfig>;
    preferredSaveTarget?: ConnectionConfigSaveTarget;
  }) => {
    connectionState = buildConnectionConfigState(config.paths, {
      user: options.user ?? connectionState.user,
      project: options.project ?? connectionState.project,
      env: connectionState.env,
      cli: connectionState.cli,
      preferredSaveTarget: options.preferredSaveTarget ?? connectionSaveTarget
    });
    connection = connectionState.effective;
    connectionSaveTarget = connectionState.saveTarget;
    client = createClientFromConnection(connection);
  };

  const persistConnection = async (target: ConnectionConfigSaveTarget) => {
    await saveConnectionConfig(
      config.paths,
      target,
      target === "project" ? connectionState.project : connectionState.user
    );
  };

  const persistSettings = async () => {
    await saveUserSessionSettings(config.paths, settingsState.user);
  };

  const applyConnectionPatch = async (
    patch: Partial<ConnectionConfig>,
    target = connectionSaveTarget
  ) => {
    // 任何连接更新都重新走一遍“分层合并 -> 归一化 -> 重建 client”的全流程，
    // 保证 effective / sources / saveTarget 始终一致。
    const sourcePatch = normalizeConnectionPatch(patch, connection);
    rebuildConnectionState({
      user:
        target === "user"
          ? mergePersistedSource(connectionState.user, sourcePatch)
          : connectionState.user,
      project:
        target === "project"
          ? mergePersistedSource(connectionState.project, sourcePatch)
          : connectionState.project,
      preferredSaveTarget: target
    });

    if (Object.keys(sourcePatch).length > 0) {
      await persistConnection(target);
    }

    await resetSystemMessage();
  };

  return {
    config,
    memoryService,
    messages,
    workspaceRoot: config.paths.workspaceRoot,
    requestPatches: config.requestPatches,
    getMainAgentToolSchemas,
    getSessionId: () => sessionHistory.getCurrentSessionId(),
    getSessionHistoryDirectory: () => path.join(config.paths.alyceDirectory, "sessions"),
    hasConnectionConfig: () => connection.apiKey.trim().length > 0,
    getConnectionConfig: () => ({ ...connection }),
    getConnectionConfigState: () => cloneConnectionConfigState(connectionState),
    getSettings: () => ({ ...settings }),
    getSettingsState: () => cloneSessionSettingsState(settingsState),
    getAllowedRoots: () => getAllowedRootsSnapshot(),
    getSessionAdditionalDirectories: () => [...sessionAdditionalDirectories],
    setSessionAdditionalDirectories: async (directories) => {
      sessionAdditionalDirectories = normalizeAdditionalDirectories(
        directories,
        config.paths.workspaceRoot
      );
      await resetSystemMessage();
    },
    requireClient: () => {
      if (!connection.apiKey.trim()) {
        throw new Error("Connection is incomplete. Open settings and fill API key, URL, and model.");
      }

      if (!client) {
        client = createClientFromConnection(connection);
      }

      if (!client) {
        throw new Error("Failed to initialize OpenAI client from current connection config.");
      }

      return client;
    },
    getCurrentModel: () => connection.model,
    setCurrentModel: async (model) => {
      await applyConnectionPatch({ model });
    },
    updateConnectionConfig: async (patch, target) => {
      await applyConnectionPatch(patch, target);
    },
    updateSettings: async (patch) => {
      const userPatch = normalizeSettingsPatch(patch, config.paths.workspaceRoot);
      // 会话设置只回写 user 层；project / env / cli 仍然参与最终覆盖，但不会被保存动作覆盖掉。
      settingsState = buildSessionSettingsState(config.paths, {
        project: settingsState.project,
        user: mergePersistedSource(settingsState.user, userPatch),
        env: settingsState.env,
        cli: settingsState.cli
      });
      settings = settingsState.effective;
      contextBudgetService.setModelContextWindowOverrides(settings.modelContextWindowOverrides);
      conversationCompactor.updateConfig(createConversationCompactionConfig(settings));
      sessionMemoryTrigger.updateConfig(createSessionMemoryTriggerConfig(config, settings));
      sessionMemoryExtractor.updateConfig(createSessionMemoryExtractorConfig(config, settings));
      for (const session of subagentSessions.values()) {
        session.contextBudgetService.setModelContextWindowOverrides(settings.modelContextWindowOverrides);
        session.conversationCompactor.updateConfig(createConversationCompactionConfig(settings));
      }
      memoryService.setSessionMemoryEnabled(settings.sessionMemoryEnabled);
      promptResolver.clearSessionCache();
      await persistSettings();
      await resetSystemMessage();
    },
    resetSystemMessage,
    clearConversation: async () => {
      // 清空会话时保留连接与设置，仅重置对话、记忆缓存和文件回滚历史。
      await sessionHistory.flush();
      sessionHistory.startNewSession();
      currentSessionTaskIndex.clear();
      await resetVolatileConversationState();
      memoryService.setSessionMemorySourcePath(getSessionMemorySourcePath());
      messages.splice(1);
      await resetSystemMessage();
    },
    clearPromptCache: () => promptResolver.clearSessionCache(),
    recordSessionTurn: async ({ apiMessages, uiMessages }) => {
      await sessionHistory.recordTurn({ apiMessages, uiMessages });
    },
    recordSessionConversationSnapshot: async ({ apiMessages, uiMessages, uiBaseMessageCount }) => {
      await sessionHistory.recordConversationSnapshot({
        apiMessages,
        uiMessages,
        uiBaseMessageCount,
        sessionMemory: memoryService.getSessionMemory()
      });
    },
    recordSessionMemory: async (sessionMemory) => {
      await sessionHistory.recordSessionMemory(
        sessionMemory === undefined ? memoryService.getSessionMemory() : sessionMemory
      );
    },
    recordSessionSubagentEvent: async (event) => {
      await sessionHistory.recordSubagentEvent(event);
    },
    recordSessionRewind: async (options) => {
      await sessionHistory.recordRewind(options);
    },
    flushSessionHistory: async () => {
      clearInterval(subagentMemoryGcTimer);
      await sessionHistory.flush();
      await mcpRuntime.close();
    },
    listSessionHistory: (options = {}) =>
      sessionHistory.listSessions({
        limit: options.limit,
        excludeSessionId: options.excludeCurrent ? sessionHistory.getCurrentSessionId() : undefined
      }),
    findSessionHistory: (query, options = {}) =>
      sessionHistory.findSessions(query, {
        excludeSessionId: options.excludeCurrent ? sessionHistory.getCurrentSessionId() : undefined
      }),
    resumeSessionHistory: async (sessionId) => {
      await sessionHistory.flush();
      const loaded = await sessionHistory.loadSession(sessionId);
      const resume = prepareSessionResume(loaded);
      sessionHistory.adoptExistingSession(resume.sessionId, loaded.lastSequence);
      await resetVolatileConversationState();
      applySubagentTaskIndex(resume.sessionId, resume.subagentTaskIndex);
      memoryService.setSessionMemory(resume.sessionMemory);
      memoryService.setSessionMemorySourcePath(getSessionMemorySourcePath());
      messages.splice(
        0,
        messages.length,
        {
          role: "system",
          content: await buildSystemPrompt()
        },
        ...resume.apiMessages
      );
      return resume;
    },
    runSubagentStorageCleanup: async (options = {}) => {
      const report = await cleanupSubagentStorageArtifacts({
        storage: subagentTaskStorage,
        apply: options.apply === true
      });
      evictExpiredSubagentSessionsFromMemory(true);
      return report;
    },
    buildContextPreview: async (nextUserInput, options = {}) => {
      const previewTimestamp = formatSystemDateTime(new Date());
      const trimmedInput = nextUserInput?.trim();
      const previewUserMessage: SessionMessage | undefined = trimmedInput
        ? {
            role: "user",
            content: trimmedInput
          }
        : undefined;
      const tools = await getMainAgentToolSchemas({
        abortSignal: options.abortSignal
      });
      const previewMessages = (previewUserMessage ? [...messages, previewUserMessage] : messages)
        .map((message) => ({ ...message }));
      previewMessages[0] = {
        role: "system",
        content: await buildSystemPrompt({
          availableTools: getToolNamesFromSchemas(tools)
        })
      };

      return buildNextTurnContextPreview({
        currentModel: connection.model,
        messages: previewMessages,
        gcliGeminiCompat: shouldUseGcliGeminiCompat(connection.baseURL, connection.model),
        messageTimestampsEnabled: settings.messageTimestampsEnabled,
        currentRequestTimestamp: previewTimestamp,
        tools,
        requestPatches: config.requestPatches,
        contextBudgetService
      });
    },
    getContextBudgetService: () => contextBudgetService,
    estimateContextBudget: (options = {}) => {
      return contextBudgetService.estimateRequest(buildPatchedChatCompletionRequest({
        model: options.model ?? connection.model,
        messages: options.messages ?? messages,
        tools: options.tools ?? TOOL_SCHEMAS,
        temperature: 0.2,
        toolChoice: "auto",
        gcliGeminiCompat: options.gcliGeminiCompat ??
          shouldUseGcliGeminiCompat(connection.baseURL, options.model ?? connection.model),
        messageTimestampsEnabled: settings.messageTimestampsEnabled,
        requestPatches: config.requestPatches
      }));
    },
    maybeCompactConversation: async ({ client: compactClient, model, force, querySource = "main", abortSignal }) => {
      if (!settings.conversationCompactionEnabled) {
        return false;
      }
      if (querySource === "compact" || querySource === "session_memory") {
        return false;
      }

      const compacted = await conversationCompactor.maybeCompact({
        client: compactClient,
        model,
        messages,
        force,
        abortSignal
      });
      if (compacted) {
        fileReadState.clear();
      }
      return compacted;
    },
    scheduleSessionMemoryExtraction: ({ client: extractionClient, model, querySource = "main", abortSignal }) => {
      if (querySource !== "main") {
        return;
      }

      const snapshot = contextBudgetService.estimateRequest(buildPatchedChatCompletionRequest({
        model,
        messages,
        tools: TOOL_SCHEMAS,
        temperature: 0.2,
        toolChoice: "auto",
        gcliGeminiCompat: shouldUseGcliGeminiCompat(connection.baseURL, model),
        messageTimestampsEnabled: settings.messageTimestampsEnabled,
        requestPatches: config.requestPatches
      }));
      const decision = sessionMemoryTrigger.shouldExtract({
        messages,
        currentTokens: snapshot.estimatedInputTokens
      });
      if (!decision.shouldExtract) {
        return;
      }

      const extractionMessages = cloneJson(messages);
      const expectedSessionId = sessionHistory.getCurrentSessionId();
      const expectedMessageCount = messages.length;
      const currentTokens = decision.currentTokens;
      void (async () => {
        const currentMemory = memoryService.getSessionMemory();
        const extraction = sessionMemoryExtractor.schedule({
          client: extractionClient,
          model,
          messages: extractionMessages,
          currentMemory: currentMemory?.markdown ?? "",
          memoryPath: memoryService.getSessionMemoryFilePath(),
          requestPatches: config.requestPatches,
          abortSignal,
          shouldCommit: () =>
            sessionHistory.getCurrentSessionId() === expectedSessionId &&
            messages.length >= expectedMessageCount
        });
        if (!extraction) {
          return;
        }

        const result = await extraction;
        if (result.status === "updated" && result.markdown) {
          // Background extraction can finish after rewind/resume; commit only
          // when the live conversation still has the exact scheduled prefix.
          if (
            sessionHistory.getCurrentSessionId() !== expectedSessionId ||
            messages.length < expectedMessageCount ||
            !messagesContainPrefix(messages, extractionMessages)
          ) {
            return;
          }

          memoryService.updateSessionMemory(result.markdown);
          await sessionHistory.recordSessionMemory(memoryService.getSessionMemory());
          sessionMemoryTrigger.recordExtraction({
            messages: extractionMessages,
            currentTokens
          });
        }
      })().catch(() => undefined);
    },
    createVolatileConversationSnapshot,
    restoreVolatileConversationSnapshot,
    beginTurn: (turnId) => {
      fileHistoryManager.beginTurn(turnId);
    },
    hasTrackedFileChanges: (turnId) => fileHistoryManager.hasTrackedFiles(turnId),
    restoreFilesForTurn: (turnId) => fileHistoryManager.restoreTurn(turnId),
    discardTurn: (turnId) => {
      fileHistoryManager.removeTurn(turnId);
    },
    createToolContext: ({
      turnId,
      abortSignal,
      requestApproval,
      askUserQuestions,
      getTodos,
      setTodos,
      recordToolActivity
    }) => ({
      // 工具在执行前会先登记 turnId，并在写文件前抓取快照，便于中断后回滚。
      workspaceRoot: config.paths.workspaceRoot,
      get allowedRoots() {
        return resolveAllowedRoots(
          config.paths.workspaceRoot,
          settings,
          sessionAdditionalDirectories
        );
      },
      commandTimeoutMs: settings.commandTimeoutMs,
      turnId,
      abortSignal,
      requestApproval: (request) => requestApproval(request, { signal: abortSignal }),
      askUserQuestions,
      getTodos,
      setTodos,
      recordToolActivity,
      mcpRuntime,
      captureFileBeforeWrite: (absolutePath) => fileHistoryManager.captureBeforeWrite(turnId, absolutePath),
      recordFileRead: (absolutePath, state) => {
        fileReadState.set(path.resolve(absolutePath), { ...state });
      },
      getFileReadState: (absolutePath) => {
        const state = fileReadState.get(path.resolve(absolutePath));
        return state ? { ...state } : undefined;
      },
      runSubagent: (input) => runSubagent(input, {
        turnId,
        abortSignal,
        requestApproval,
        askUserQuestions,
        getTodos,
        setTodos,
        recordToolActivity
      }),
      launchSubagentTask: (input) => launchSubagentTask(input, {
        turnId,
        requestApproval,
        askUserQuestions,
        getTodos,
        setTodos,
        recordToolActivity
      }),
      listSubagentTasks: () => listSubagentTasks(),
      getSubagentTask: (taskId) => getSubagentTask(taskId),
      recordSubagentTaskRetrieved: async (taskId) => {
        const session = subagentSessions.get(taskId);
        if (!session || !isCurrentSessionSubagent(session)) {
          return;
        }

        try {
          await recordSubagentSessionEvent(session, "subagent-retrieved", "Task output retrieved via TaskGet.");
        } catch {
          // Retrieval logging is best-effort and must not fail TaskGet.
        }
      },
      stopSubagentTask: (taskId) => stopSubagentTask(taskId),
      getSubagentDefinition: (type) => loadSubagentDefinition(config.paths.workspaceRoot, type),
      listSubagentDefinitions: () => loadSubagentDefinitions(config.paths.workspaceRoot)
    })
  };

  function isCurrentSessionSubagent(session: SubagentSession) {
    return session.parentSessionId === sessionHistory.getCurrentSessionId();
  }

  function isTerminalSubagentStatus(status: SubagentTaskStatus): boolean {
    return status === "completed" || status === "failed" || status === "stopped";
  }

  function scheduleTerminalSubagentEviction(
    session: SubagentSession,
    nowMs = Date.now()
  ) {
    if (!isTerminalSubagentStatus(session.status)) {
      session.evictAfter = undefined;
      return;
    }

    if (session.evictAfter === undefined) {
      session.evictAfter = nowMs + SUBAGENT_TERMINAL_MEMORY_RETENTION_MS;
    }
  }

  function evictExpiredSubagentSessionsFromMemory(force = false) {
    const nowMs = Date.now();
    for (const [taskId, session] of subagentSessions.entries()) {
      if (session.status === "running") {
        session.evictAfter = undefined;
        continue;
      }
      if (!isTerminalSubagentStatus(session.status)) {
        continue;
      }
      if (session.controller || session.promise) {
        continue;
      }

      scheduleTerminalSubagentEviction(session, nowMs);
      if (!force && (session.evictAfter ?? Infinity) > nowMs) {
        continue;
      }

      if (isCurrentSessionSubagent(session)) {
        upsertCurrentSessionTaskIndex(session);
      }
      subagentSessions.delete(taskId);
    }
  }

  async function recordSubagentSessionEvent(
    session: SubagentSession,
    type: SessionHistorySubagentEvent["type"],
    message?: string
  ) {
    await sessionHistory.recordSubagentEvent({
      type,
      taskId: session.taskId,
      agentType: session.agentType,
      description: session.description,
      model: session.model,
      maxSteps: session.maxSteps,
      status: session.status,
      ...(message ? { message } : {}),
      ...(session.error ? { error: session.error } : {}),
      ...(session.outputPath ? { outputPath: session.outputPath } : {}),
      ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      apiMessageCount: Math.max(0, messages.length - 1)
    });
    // 事件落盘后同步刷新当前会话索引，保证 TaskList/TaskGet 读到最新状态。
    upsertCurrentSessionTaskIndex(session);
  }

  function toSessionTaskIndexItem(session: SubagentSession): SessionHistorySubagentTaskIndexItem {
    return {
      taskId: session.taskId,
      agentType: session.agentType,
      description: session.description,
      model: session.model,
      maxSteps: session.maxSteps,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      ...(session.error ? { error: session.error } : {}),
      ...(session.outputPath ? { outputPath: session.outputPath } : {})
    };
  }

  function upsertCurrentSessionTaskIndex(session: SubagentSession) {
    if (!isCurrentSessionSubagent(session)) {
      return;
    }

    currentSessionTaskIndex.set(session.taskId, toSessionTaskIndexItem(session));
  }

  function applySubagentTaskIndex(
    sessionId: SessionId,
    taskIndex: SessionHistorySubagentTaskIndexItem[]
  ) {
    currentSessionTaskIndex.clear();
    for (const item of taskIndex) {
      const normalizedItem = normalizeHistoricalTaskIndexItem({ ...item });
      currentSessionTaskIndex.set(normalizedItem.taskId, normalizedItem);
    }

    for (const [taskId, session] of subagentSessions.entries()) {
      if (session.parentSessionId === sessionId) {
        subagentSessions.delete(taskId);
      }
    }

    // 历史任务仅保留在轻量索引中，按需（TaskGet/TaskStop/resume task_id）再懒加载到内存。
  }

  function normalizeHistoricalTaskIndexItem(
    item: SessionHistorySubagentTaskIndexItem
  ): SessionHistorySubagentTaskIndexItem {
    if (item.status !== "running") {
      return item;
    }

    const now = new Date().toISOString();
    return {
      ...item,
      status: "failed",
      updatedAt: now,
      completedAt: item.completedAt ?? now,
      error: item.error ?? HISTORICAL_SUBAGENT_RUNNING_ERROR
    };
  }

  function createIndexedSubagentSession(
    indexItem: SessionHistorySubagentTaskIndexItem,
    sessionId: SessionId
  ): SubagentSession {
    const storageIdentity = subagentTaskStorage.getStorageIdentity(indexItem.taskId, sessionId);
    return {
      taskId: indexItem.taskId,
      agentType: indexItem.agentType,
      description: indexItem.description,
      model: indexItem.model,
      maxSteps: indexItem.maxSteps,
      parentSessionId: sessionId,
      transcriptPath: storageIdentity.transcriptPath,
      metadataPath: storageIdentity.metadataPath,
      outputPath: indexItem.outputPath ?? storageIdentity.outputPath,
      createdAt: indexItem.createdAt,
      updatedAt: indexItem.updatedAt,
      status: indexItem.status,
      startedAt: indexItem.startedAt,
      completedAt: indexItem.completedAt,
      evictAfter: isTerminalSubagentStatus(indexItem.status)
        ? Date.now() + SUBAGENT_TERMINAL_MEMORY_RETENTION_MS
        : undefined,
      output: undefined,
      error: indexItem.error,
      progress: [],
      messages: [],
      transcriptSyncedMessageCount: 0,
      contextBudgetService: createContextBudgetService(settings),
      conversationCompactor: new ConversationCompactor(createConversationCompactionConfig(settings))
    };
  }

  function getIndexedSubagentSession(taskId: string): SubagentSession | undefined {
    const indexItem = currentSessionTaskIndex.get(taskId);
    if (!indexItem) {
      return undefined;
    }

    const normalizedItem = normalizeHistoricalTaskIndexItem(indexItem);
    if (normalizedItem !== indexItem) {
      currentSessionTaskIndex.set(taskId, normalizedItem);
    }

    const session = createIndexedSubagentSession(
      normalizedItem,
      sessionHistory.getCurrentSessionId()
    );
    subagentSessions.set(taskId, session);
    return session;
  }

  function toSubagentTaskInfoFromIndex(
    item: SessionHistorySubagentTaskIndexItem,
    session?: SubagentSession
  ): SubagentTaskInfo {
    return {
      taskId: item.taskId,
      agentType: item.agentType,
      description: item.description,
      model: item.model,
      maxSteps: item.maxSteps,
      status: session?.status ?? item.status,
      createdAt: item.createdAt,
      updatedAt: session?.updatedAt ?? item.updatedAt,
      ...(session?.startedAt ?? item.startedAt ? { startedAt: session?.startedAt ?? item.startedAt } : {}),
      ...(session?.completedAt ?? item.completedAt ? { completedAt: session?.completedAt ?? item.completedAt } : {}),
      ...(session?.output !== undefined ? { output: session.output } : {}),
      ...(session?.error ?? item.error ? { error: session?.error ?? item.error } : {}),
      progress: session?.progress ?? []
    };
  }

  function mapTranscriptEntryToProgressEvent(entry: SubagentTranscriptEntry): SubagentProgressEvent | null {
    if (entry.type === "tool-event") {
      return {
        timestamp: entry.timestamp,
        type: entry.event.phase === "start" ? "tool_start" : "tool_result",
        message: entry.event.phase === "start"
          ? `Running ${entry.event.toolName}`
          : `Finished ${entry.event.toolName}`,
        toolName: entry.event.toolName,
        rawArguments: entry.event.rawArguments,
        result: entry.event.result
      };
    }

    if (entry.type === "status") {
      return {
        timestamp: entry.timestamp,
        type: "status",
        message: entry.message
      };
    }

    return null;
  }

  async function hydrateSubagentSessionFromDisk(session: SubagentSession) {
    if (session.status === "running") {
      return;
    }

    // 已经加载过输出和进度时不重复扫描 transcript，降低 TaskGet 的 IO 成本。
    if (session.output !== undefined && session.progress.length > 0) {
      return;
    }

    if (session.output === undefined) {
      try {
        const output = await subagentHistoryStore.readOutput(session.outputPath);
        if (output !== undefined) {
          session.output = output;
        }
      } catch {
        // 输出文件缺失或读取失败时，继续走 transcript 回退，不阻塞工具响应。
      }
    }

    const transcriptEntries = await subagentHistoryStore.readTranscriptEntries(session.transcriptPath);
    if (session.progress.length === 0) {
      const progress = transcriptEntries
        .map(mapTranscriptEntryToProgressEvent)
        .filter((event): event is SubagentProgressEvent => event !== null);
      if (progress.length > 0) {
        session.progress = progress.slice(-MAX_SUBAGENT_PROGRESS_EVENTS);
      }
    }

    const terminalStatuses = transcriptEntries
      .filter((entry): entry is Extract<SubagentTranscriptEntry, { type: "status" }> => entry.type === "status");
    const lastStatus = terminalStatuses.at(-1);
    if (lastStatus) {
      if (!session.error && lastStatus.error) {
        session.error = lastStatus.error;
      }
      if (session.output === undefined && lastStatus.output !== undefined) {
        session.output = lastStatus.output;
      }
      if (!session.startedAt && lastStatus.startedAt) {
        session.startedAt = lastStatus.startedAt;
      }
      if (!session.completedAt && lastStatus.completedAt) {
        session.completedAt = lastStatus.completedAt;
      }
    }

    scheduleTerminalSubagentEviction(session);
  }

  async function hydrateResumableSubagentSession(
    session: SubagentSession,
    expectedAgentType: string
  ) {
    const metadata = await subagentHistoryStore.readMetadata(session.metadataPath);
    if (!metadata) {
      throw new Error(
        `Cannot resume task_id ${session.taskId} because metadata is missing: ${session.metadataPath}`
      );
    }

    if (metadata.parentSessionId !== sessionHistory.getCurrentSessionId()) {
      throw new Error(`Subagent task_id ${session.taskId} does not belong to the current session.`);
    }

    if (metadata.agentType !== expectedAgentType) {
      throw new Error(
        `Subagent task_id ${session.taskId} belongs to ${metadata.agentType}, not ${expectedAgentType}.`
      );
    }

    let transcriptEntries: SubagentTranscriptEntry[];
    try {
      transcriptEntries = await subagentHistoryStore.readTranscriptEntriesRequired(session.transcriptPath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Subagent transcript not found:")) {
        throw new Error(
          `Cannot resume task_id ${session.taskId} because transcript is missing: ${session.transcriptPath}`
        );
      }

      throw error;
    }

    const transcriptMessages = transcriptEntries
      .filter((entry): entry is Extract<SubagentTranscriptEntry, { type: "api-message" }> => entry.type === "api-message")
      .map((entry) => entry.message);
    const resumableMessages = prepareResumableSubagentMessages(transcriptMessages);
    if (resumableMessages.length === 0) {
      throw new Error(`Cannot resume task_id ${session.taskId} because transcript contains no resumable messages.`);
    }
    if (resumableMessages[0]?.role !== "system") {
      throw new Error(
        `Cannot resume task_id ${session.taskId} because transcript is missing the initial system message.`
      );
    }

    // 以 metadata 为权威恢复运行环境，确保 resume 后模型与 worktree 语义一致。
    session.parentSessionId = metadata.parentSessionId;
    session.agentType = metadata.agentType;
    session.description = metadata.description;
    session.model = metadata.model;
    session.maxSteps = metadata.maxSteps;
    session.worktreePath = metadata.worktreePath;
    session.baseWorkspaceRoot = metadata.baseWorkspaceRoot;
    session.messages = resumableMessages;
    session.transcriptSyncedMessageCount = resumableMessages.length;

    await hydrateSubagentSessionFromDisk(session);
  }

  async function runSubagent(
    input: SubagentRunInput,
    parentContextOptions: Parameters<SessionRuntime["createToolContext"]>[0]
  ): Promise<SubagentRunResult> {
    throwIfAborted(parentContextOptions.abortSignal);
    const session = await startSubagentSession(input);
    let output: string;
    try {
      output = await runSubagentSession(session, parentContextOptions);
      const now = new Date().toISOString();
      session.status = "completed";
      session.output = output;
      session.error = undefined;
      session.completedAt = now;
      session.updatedAt = now;
      scheduleTerminalSubagentEviction(session);
      appendSubagentProgress(session, "status", "Subagent completed.");
      await writeSubagentTerminalArtifacts(session, "Subagent completed.");
      await recordSubagentSessionEvent(session, "subagent-notification", "Subagent completed.");
    } catch (error) {
      const now = new Date().toISOString();
      const isInterrupted = isTurnInterruptedError(error, parentContextOptions.abortSignal);
      session.status = isInterrupted ? "stopped" : "failed";
      session.error = isInterrupted
        ? "Subagent task was interrupted by the parent turn."
        : error instanceof Error
          ? error.message
          : String(error);
      session.completedAt = now;
      session.updatedAt = now;
      scheduleTerminalSubagentEviction(session);
      appendSubagentProgress(
        session,
        "status",
        `${isInterrupted ? "Subagent interrupted" : "Subagent failed"}: ${session.error}`
      );
      await writeSubagentTerminalArtifacts(
        session,
        isInterrupted ? "Subagent interrupted." : "Subagent failed."
      );
      await recordSubagentSessionEvent(
        session,
        "subagent-notification",
        isInterrupted ? "Subagent interrupted." : "Subagent failed."
      );
      throw error;
    }

    return {
      taskId: session.taskId,
      agentType: session.agentType,
      description: input.description,
      model: session.model,
      maxSteps: session.maxSteps,
      output,
      ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
      ...(session.diffSummary ? { diffSummary: session.diffSummary } : {}),
      ...(session.hasChanges !== undefined ? { hasChanges: session.hasChanges } : {})
    };
  }

  async function launchSubagentTask(
    input: SubagentRunInput,
    parentContextOptions: Omit<Parameters<SessionRuntime["createToolContext"]>[0], "abortSignal">
  ): Promise<SubagentTaskLaunchResult> {
    const controller = new AbortController();
    const session = await startSubagentSession(input);
    const runToken = session.runToken;

    session.controller = controller;
    session.isolateWorktree = input.isolateWorktree;
    session.promise = runSubagentSession(session, {
      ...parentContextOptions,
      abortSignal: controller.signal
    }).then((output) => {
      if (session.runToken !== runToken || session.status !== "running") {
        return;
      }

      const now = new Date().toISOString();
      session.status = "completed";
      session.output = output;
      session.error = undefined;
      session.completedAt = now;
      session.updatedAt = now;
      session.controller = undefined;
      session.promise = undefined;
      scheduleTerminalSubagentEviction(session);
      appendSubagentProgress(session, "status", "Background subagent completed.");
      void writeSubagentTerminalArtifacts(session, "Background subagent completed.").catch(() => undefined);
      void recordSubagentSessionEvent(
        session,
        "subagent-notification",
        "Background subagent completed."
      ).catch(() => undefined);
    }).catch((error: unknown) => {
      if (session.runToken !== runToken) {
        return;
      }

      const now = new Date().toISOString();
      const wasStopped = session.status === "stopped";
      session.status = wasStopped ? "stopped" : "failed";
      session.error = wasStopped
        ? "Subagent task was stopped by TaskStop."
        : error instanceof Error
          ? error.message
          : String(error);
      session.completedAt = now;
      session.updatedAt = now;
      session.controller = undefined;
      session.promise = undefined;
      scheduleTerminalSubagentEviction(session);
      appendSubagentProgress(session, "status", `${wasStopped ? "Background subagent stopped" : "Background subagent failed"}: ${session.error}`);
      void writeSubagentTerminalArtifacts(
        session,
        wasStopped ? "Background subagent stopped." : "Background subagent failed."
      ).catch(() => undefined);
      void recordSubagentSessionEvent(
        session,
        "subagent-notification",
        wasStopped ? "Background subagent stopped." : "Background subagent failed."
      ).catch(() => undefined);
    });

    return {
      taskId: session.taskId,
      agentType: session.agentType,
      description: session.description,
      status: "running",
      model: session.model,
      maxSteps: session.maxSteps,
      startedAt: session.startedAt ?? session.updatedAt
    };
  }

  async function startSubagentSession(input: SubagentRunInput): Promise<SubagentSession> {
    const agent = await loadSubagentDefinition(config.paths.workspaceRoot, input.agentType);
    if (!agent) {
      throw new Error(`Unknown subagent type: ${input.agentType}`);
    }

    const fallbackModel = input.model ?? agent.model ?? connection.model;
    const fallbackConfiguredMaxSteps = input.maxSteps ?? agent.maxSteps ?? settings.maxSteps;
    const fallbackMaxSteps = Math.max(1, Math.min(settings.maxSteps, fallbackConfiguredMaxSteps));
    const session = await getOrCreateSubagentSession(input, {
      model: fallbackModel,
      systemPrompt: await buildSubagentSystemPrompt({
        agentType: input.agentType,
        description: input.description,
        model: fallbackModel
      }),
      maxSteps: fallbackMaxSteps
    });
    if (session.status === "running" && session.promise) {
      throw new Error(`Subagent task_id ${session.taskId} is already running.`);
    }

    const configuredMaxSteps = input.maxSteps ?? session.maxSteps ?? agent.maxSteps ?? settings.maxSteps;
    const maxSteps = Math.max(1, Math.min(settings.maxSteps, configuredMaxSteps));
    const model = input.model ?? session.model ?? agent.model ?? connection.model;

    const now = new Date().toISOString();
    const isExistingSession = session.startedAt !== undefined;
    const runToken = randomUUID();

    session.messages.push({
      role: "user",
      content: input.prompt
    });
    session.description = input.description;
    session.model = model;
    session.maxSteps = maxSteps;
    session.status = "running";
    session.error = undefined;
    session.output = undefined;
    session.completedAt = undefined;
    session.evictAfter = undefined;
    session.promise = undefined;
    session.controller = undefined;
    session.runToken = runToken;
    session.isolateWorktree = input.isolateWorktree;
    session.activeWorktreePath = undefined;
    if (!isExistingSession) {
      session.worktreePath = undefined;
    }
    session.diffSummary = undefined;
    session.hasChanges = undefined;
    session.baseWorkspaceRoot = config.paths.workspaceRoot;
    session.startedAt = now;
    session.updatedAt = now;
    appendSubagentProgress(session, "status", `Subagent started: ${input.description}`);
    await writeSubagentMetadata(session);
    await appendSubagentStatusEntry(session, `Subagent started: ${input.description}`);
    await recordSubagentSessionEvent(session, "subagent-started", `Subagent started: ${input.description}`);

    return session;
  }

  async function runSubagentSession(
    session: SubagentSession,
    parentContextOptions: Parameters<SessionRuntime["createToolContext"]>[0]
  ): Promise<string> {
    const agent = await loadSubagentDefinition(config.paths.workspaceRoot, session.agentType);
    if (!agent) {
      throw new Error(`Unknown subagent type: ${session.agentType}`);
    }

    const clientForSubagent = client ?? createClientFromConnection(connection);
    if (!clientForSubagent) {
      throw new Error("Connection is incomplete. Open settings and fill API key, URL, and model.");
    }

    const runToken = session.runToken;
    const isCurrentRun = () => session.runToken === runToken;
    const workspaceRoot = await prepareSubagentWorkspace(session, agent);
    throwIfAborted(parentContextOptions.abortSignal);
    if (!isCurrentRun()) {
      throw new TurnInterruptedError("subagent-superseded", "Subagent run was superseded by a newer task state.");
    }

    const recordProgress = (
      type: SubagentProgressEvent["type"],
      message: string,
      patch: Partial<SubagentProgressEvent> = {}
    ) => {
      if (!isCurrentRun()) {
        return;
      }

      appendSubagentProgress(session, type, message, patch);
    };
    session.messages[0] = {
      role: "system",
      content: await buildSubagentSystemPrompt({
        agentType: session.agentType,
        description: session.description,
        model: session.model
      }, workspaceRoot)
    };
    await writeSubagentMetadata(session);
    await appendUnsyncedSubagentMessages(session);

    const subagentContext: ToolExecutionContext = {
      workspaceRoot,
      get allowedRoots() {
        return resolveSubagentAllowedRoots(
          workspaceRoot,
          agent,
          settings,
          sessionAdditionalDirectories
        );
      },
      commandTimeoutMs: settings.commandTimeoutMs,
      turnId: parentContextOptions.turnId,
      abortSignal: parentContextOptions.abortSignal,
      requestApproval: (request) =>
        parentContextOptions.requestApproval(
          {
            ...request,
            title: `[${agent.label}] ${request.title}`,
            details: [`Subagent: ${agent.type}`, ...request.details]
          },
          { signal: parentContextOptions.abortSignal }
        ),
      askUserQuestions: parentContextOptions.askUserQuestions,
      getTodos: parentContextOptions.getTodos,
      setTodos: parentContextOptions.setTodos,
      recordToolActivity: parentContextOptions.recordToolActivity,
      toolPolicy: agent.policy,
      captureFileBeforeWrite: (absolutePath) =>
        session.activeWorktreePath && isPathInsideDirectory(session.activeWorktreePath, absolutePath)
          ? Promise.resolve()
          : fileHistoryManager.captureBeforeWrite(parentContextOptions.turnId, absolutePath),
      recordFileRead: (absolutePath, state) => {
        fileReadState.set(path.resolve(absolutePath), { ...state });
      },
      getFileReadState: (absolutePath) => {
        const state = fileReadState.get(path.resolve(absolutePath));
        return state ? { ...state } : undefined;
      }
    };

    try {
      const output = await runAgentTurn(clientForSubagent, session.messages, {
        model: session.model,
        maxSteps: session.maxSteps,
        querySource: "subagent",
        context: subagentContext,
        tools: getToolSchemasByName(getAllowedToolNamesForSubagent(agent)),
        requestPatches: config.requestPatches,
        contextBudgetService: session.contextBudgetService,
        refreshTools: async () => getToolSchemasByName(getAllowedToolNamesForSubagent(agent)),
        preflightCompactConversation: async ({ abortSignal, querySource }) => {
          if (querySource === "compact" || querySource === "session_memory") {
            return false;
          }
          return session.conversationCompactor.maybeCompact({
            client: clientForSubagent,
            model: session.model,
            messages: session.messages,
            force: true,
            abortSignal
          });
        },
        onContextCompactionStart: (snapshot) => {
          recordProgress("status", `Compacting context (${Math.round(snapshot.usedPercent)}% used).`);
        },
        onContextCompactionResult: (event) => {
          recordProgress(
            "status",
            `Context ${event.compacted ? "compacted" : "checked"}: ${Math.round(event.before.usedPercent)}% -> ${Math.round(event.after.usedPercent)}%.`
          );
        },
        abortSignal: parentContextOptions.abortSignal,
        messageTimestampsEnabled: settings.messageTimestampsEnabled,
        gcliGeminiCompat: shouldUseGcliGeminiCompat(connection.baseURL, session.model),
        onThinking: (content) => {
          recordProgress("thinking", content);
        },
        onToolCallStart: (toolName, rawArguments) => {
          recordProgress("tool_start", `Running ${toolName}`, {
            toolName,
            rawArguments
          });
          void appendSubagentToolEvent(session, {
            phase: "start",
            toolName,
            rawArguments
          }).catch(() => undefined);
        },
        onToolCallResult: (toolName, result, rawArguments) => {
          recordProgress("tool_result", `Finished ${toolName}`, {
            toolName,
            rawArguments,
            result
          });
          void appendSubagentToolEvent(session, {
            phase: "result",
            toolName,
            rawArguments,
            result
          }).catch(() => undefined);
        },
        onMessagesAppended: async () => {
          await appendUnsyncedSubagentMessages(session);
        }
      });
      await appendUnsyncedSubagentMessages(session);
      return output;
    } catch (error) {
      await appendUnsyncedSubagentMessages(session).catch(() => undefined);
      throw error;
    } finally {
      if (isCurrentRun()) {
        await finalizeSubagentWorkspace(session);
      }
    }
  }

  async function getOrCreateSubagentSession(
    input: SubagentRunInput,
    options: {
      model: string;
      maxSteps: number;
      systemPrompt: string;
    }
  ): Promise<SubagentSession> {
    if (input.taskId) {
      let existing = subagentSessions.get(input.taskId);
      if (!existing) {
        existing = getIndexedSubagentSession(input.taskId);
      }
      if (!existing) {
        throw new Error(`Unknown subagent task_id: ${input.taskId}`);
      }
      if (!isCurrentSessionSubagent(existing)) {
        throw new Error(`Subagent task_id ${input.taskId} does not belong to the current session.`);
      }

      if (existing.agentType !== input.agentType) {
        throw new Error(
          `Subagent task_id ${input.taskId} belongs to ${existing.agentType}, not ${input.agentType}.`
        );
      }

      if (!(existing.status === "running" && existing.promise)) {
        await hydrateResumableSubagentSession(existing, input.agentType);
      }

      return existing;
    }

    const taskId = randomUUID();
    const storageIdentity = subagentTaskStorage.getStorageIdentity(taskId);
    const now = new Date().toISOString();
    const session: SubagentSession = {
      taskId,
      agentType: input.agentType,
      description: input.description,
      model: options.model,
      maxSteps: options.maxSteps,
      parentSessionId: storageIdentity.parentSessionId,
      transcriptPath: storageIdentity.transcriptPath,
      metadataPath: storageIdentity.metadataPath,
      outputPath: storageIdentity.outputPath,
      createdAt: now,
      updatedAt: now,
      status: "completed",
      progress: [],
      messages: [
        {
          role: "system",
          content: options.systemPrompt
        },
        ...(input.forkContext ? buildForkContextMessages() : [])
      ],
      transcriptSyncedMessageCount: 0,
      contextBudgetService: createContextBudgetService(settings),
      conversationCompactor: new ConversationCompactor(createConversationCompactionConfig(settings))
    };
    subagentSessions.set(taskId, session);
    return session;
  }

  function listSubagentTasks(): SubagentTaskInfo[] {
    evictExpiredSubagentSessionsFromMemory();
    const merged = new Map<string, SubagentTaskInfo>();

    // 先放入轻量索引，保证“历史任务”在没有活跃内存会话时仍可见。
    for (const item of currentSessionTaskIndex.values()) {
      merged.set(item.taskId, toSubagentTaskInfoFromIndex(item));
    }

    // 再用内存态覆盖索引态，确保运行中任务和最新状态优先展示。
    for (const session of subagentSessions.values()) {
      if (!isCurrentSessionSubagent(session)) {
        continue;
      }

      merged.set(session.taskId, toSubagentTaskInfo(session));
    }

    return [...merged.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function getSubagentTask(taskId: string): Promise<SubagentTaskInfo | undefined> {
    evictExpiredSubagentSessionsFromMemory();
    let session = subagentSessions.get(taskId);
    if (session && !isCurrentSessionSubagent(session)) {
      return undefined;
    }
    if (!session) {
      session = getIndexedSubagentSession(taskId);
    }
    if (!session) {
      return undefined;
    }

    await hydrateSubagentSessionFromDisk(session);
    upsertCurrentSessionTaskIndex(session);
    return toSubagentTaskInfo(session);
  }

  async function stopSubagentTask(taskId: string): Promise<SubagentTaskStopResult> {
    const session = subagentSessions.get(taskId);
    if (session && isCurrentSessionSubagent(session)) {
      if (session.status !== "running") {
        return {
          taskId,
          status: session.status,
          message: `Subagent task is already ${session.status}.`,
          task: toSubagentTaskInfo(session)
        };
      }

      session.controller?.abort("task-stop");
      const now = new Date().toISOString();
      session.status = "stopped";
      session.error = "Subagent task was stopped by TaskStop.";
      session.completedAt = now;
      session.updatedAt = now;
      scheduleTerminalSubagentEviction(session);
      appendSubagentProgress(session, "status", "Subagent task stop requested.");
      await writeSubagentTerminalArtifacts(session, "Subagent task stop requested.");
      await recordSubagentSessionEvent(session, "subagent-stopped", "Subagent task stop requested.");

      return {
        taskId,
        status: session.status,
        message: "Stop requested for background subagent task.",
        stopRequested: true,
        task: toSubagentTaskInfo(session)
      };
    }

    // 任务不在当前进程运行态时，回退到会话索引，返回可解释的终态信息。
    const indexItem = currentSessionTaskIndex.get(taskId);
    if (indexItem) {
      const normalizedItem = normalizeHistoricalTaskIndexItem(indexItem);
      if (normalizedItem !== indexItem) {
        currentSessionTaskIndex.set(taskId, normalizedItem);
      }
      return {
        taskId,
        status: normalizedItem.status,
        message: normalizedItem.status === "failed"
          ? "Historical task is not running in this process and was marked failed."
          : `Historical task is already ${normalizedItem.status}.`,
        task: toSubagentTaskInfoFromIndex(normalizedItem)
      };
    }
    return {
      taskId,
      status: "not_found",
      message: `Unknown subagent task_id: ${taskId}`
    };
  }

  function abortRunningSubagentTasks() {
    for (const session of subagentSessions.values()) {
      if (session.status !== "running") {
        continue;
      }

      session.controller?.abort("session-reset");
      const now = new Date().toISOString();
      session.status = "failed";
      session.error = "Subagent task was interrupted by session reset.";
      session.completedAt = now;
      session.updatedAt = now;
      scheduleTerminalSubagentEviction(session);
      session.controller = undefined;
      session.promise = undefined;
      session.runToken = randomUUID();
      appendSubagentProgress(session, "status", "Subagent task interrupted by session reset.");
    }
  }

  function toSubagentTaskInfo(session: SubagentSession): SubagentTaskInfo {
    return {
      taskId: session.taskId,
      agentType: session.agentType,
      description: session.description,
      model: session.model,
      maxSteps: session.maxSteps,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      ...(session.output !== undefined ? { output: session.output } : {}),
      ...(session.error !== undefined ? { error: session.error } : {}),
      progress: [...session.progress],
      ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
      ...(session.diffSummary ? { diffSummary: session.diffSummary } : {}),
      ...(session.hasChanges !== undefined ? { hasChanges: session.hasChanges } : {})
    };
  }

  function appendSubagentProgress(
    session: SubagentSession,
    type: SubagentProgressEvent["type"],
    message: string,
    patch: Partial<SubagentProgressEvent> = {}
  ) {
    session.progress.push({
      timestamp: new Date().toISOString(),
      type,
      message: truncateProgressText(message, MAX_SUBAGENT_PROGRESS_MESSAGE_CHARS),
      ...(patch.toolName !== undefined
        ? { toolName: truncateProgressText(patch.toolName, MAX_SUBAGENT_PROGRESS_DETAIL_CHARS) }
        : {}),
      ...(patch.rawArguments !== undefined
        ? { rawArguments: truncateProgressText(patch.rawArguments, MAX_SUBAGENT_PROGRESS_DETAIL_CHARS) }
        : {}),
      ...(patch.result !== undefined
        ? { result: truncateProgressText(patch.result, MAX_SUBAGENT_PROGRESS_DETAIL_CHARS) }
        : {})
    });
    if (session.progress.length > MAX_SUBAGENT_PROGRESS_EVENTS) {
      session.progress.splice(0, session.progress.length - MAX_SUBAGENT_PROGRESS_EVENTS);
    }
    session.updatedAt = new Date().toISOString();
  }

  function createSubagentMetadata(session: SubagentSession): SubagentMetadataV1 {
    return {
      version: SUBAGENT_METADATA_VERSION,
      agentId: session.taskId,
      parentSessionId: session.parentSessionId,
      agentType: session.agentType,
      description: session.description,
      model: session.model,
      maxSteps: session.maxSteps,
      createdAt: session.createdAt,
      ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
      ...(session.baseWorkspaceRoot ? { baseWorkspaceRoot: session.baseWorkspaceRoot } : {})
    };
  }

  async function writeSubagentMetadata(session: SubagentSession) {
    const metadata = createSubagentMetadata(session);
    await subagentHistoryStore.writeMetadata(session.metadataPath, metadata);
    await appendSubagentTranscriptEntries(session, [
      {
        type: "subagent-meta",
        timestamp: new Date().toISOString(),
        agentId: session.taskId,
        parentSessionId: session.parentSessionId,
        metadata
      }
    ]);
  }

  async function appendSubagentTranscriptEntries(
    session: SubagentSession,
    entries: SubagentTranscriptEntry[]
  ) {
    await subagentHistoryStore.appendTranscriptEntries(session.transcriptPath, entries);
  }

  async function appendUnsyncedSubagentMessages(session: SubagentSession) {
    if (session.messages.length <= session.transcriptSyncedMessageCount) {
      return;
    }

    const pendingMessages = session.messages
      .slice(session.transcriptSyncedMessageCount)
      .map((message) => cloneJson(message));
    const timestamp = new Date().toISOString();
    await appendSubagentTranscriptEntries(
      session,
      pendingMessages.map((message) => ({
        type: "api-message",
        timestamp,
        agentId: session.taskId,
        parentSessionId: session.parentSessionId,
        message
      }))
    );
    session.transcriptSyncedMessageCount = session.messages.length;
  }

  async function appendSubagentToolEvent(
    session: SubagentSession,
    event: SubagentTranscriptToolEvent
  ) {
    await appendSubagentTranscriptEntries(session, [
      {
        type: "tool-event",
        timestamp: new Date().toISOString(),
        agentId: session.taskId,
        parentSessionId: session.parentSessionId,
        event
      }
    ]);
  }

  async function appendSubagentStatusEntry(
    session: SubagentSession,
    message?: string
  ) {
    await appendSubagentTranscriptEntries(session, [
      {
        type: "status",
        timestamp: new Date().toISOString(),
        agentId: session.taskId,
        parentSessionId: session.parentSessionId,
        status: session.status,
        ...(message ? { message } : {}),
        ...(session.error ? { error: session.error } : {}),
        ...(session.output !== undefined ? { output: session.output } : {}),
        ...(session.startedAt ? { startedAt: session.startedAt } : {}),
        ...(session.completedAt ? { completedAt: session.completedAt } : {})
      }
    ]);
  }

  async function persistSubagentOutputFile(session: SubagentSession) {
    if (session.output === undefined) {
      return;
    }

    await subagentHistoryStore.writeOutput(session.outputPath, session.output);
  }

  async function writeSubagentTerminalArtifacts(
    session: SubagentSession,
    statusMessage: string
  ) {
    await appendUnsyncedSubagentMessages(session);
    await appendSubagentStatusEntry(session, statusMessage);
    await persistSubagentOutputFile(session);
  }

  function buildForkContextMessages(): SessionMessage[] {
    const compactedSummaryMessages = messages
      .slice(1)
      .filter((message) => message.role === "system");
    const recentConversationMessages = messages
      .slice(1)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-12);
    const forkedMessages = [
      ...compactedSummaryMessages,
      ...recentConversationMessages
    ];

    if (forkedMessages.length === 0) {
      return [];
    }

    return [
      {
        role: "user",
        content: [
          "System-provided fork context from the parent conversation.",
          "Use this only as background context for the delegated task; do not answer it directly.",
          JSON.stringify(forkedMessages, null, 2)
        ].join("\n\n")
      }
    ];
  }

  async function prepareSubagentWorkspace(
    session: SubagentSession,
    agent: SubagentDefinition
  ): Promise<string> {
    const wantsIsolation = session.isolateWorktree === true ||
      (session.isolateWorktree !== false && agent.policy.allowWrite);
    if (!wantsIsolation) {
      session.activeWorktreePath = undefined;
      session.worktreePath = undefined;
      session.baseWorkspaceRoot = undefined;
      return config.paths.workspaceRoot;
    }

    if (!await isGitRepository(config.paths.workspaceRoot)) {
      session.activeWorktreePath = undefined;
      session.worktreePath = undefined;
      session.baseWorkspaceRoot = undefined;
      if (session.isolateWorktree === true) {
        throw new Error("isolate_worktree requires the workspace to be inside a git repository.");
      }

      appendSubagentProgress(
        session,
        "status",
        "Writable subagent requested isolation, but workspace is not a git repository; continuing in the main workspace."
      );
      return config.paths.workspaceRoot;
    }

    if (session.worktreePath && await pathExists(session.worktreePath)) {
      session.activeWorktreePath = session.worktreePath;
      await writeSubagentMetadata(session);
      return session.worktreePath;
    }

    const worktreesDirectory = getWorktreesDirectory();
    await fs.mkdir(worktreesDirectory, { recursive: true });
    const worktreePath = path.join(worktreesDirectory, session.taskId);
    await fs.rm(worktreePath, { recursive: true, force: true });
    await runGitCommand(["worktree", "prune"], config.paths.workspaceRoot);
    await runGitCommand(["worktree", "add", "--detach", worktreePath, "HEAD"], config.paths.workspaceRoot);
    session.worktreePath = worktreePath;
    session.activeWorktreePath = worktreePath;
    session.baseWorkspaceRoot = config.paths.workspaceRoot;
    await writeSubagentMetadata(session);
    appendSubagentProgress(session, "status", `Created isolated git worktree: ${worktreePath}`);
    return worktreePath;
  }

  async function finalizeSubagentWorkspace(session: SubagentSession) {
    if (!session.activeWorktreePath) {
      return;
    }

    try {
      const diffSummary = await runGitCommand(["status", "--short"], session.activeWorktreePath);
      session.diffSummary = diffSummary.trim() || "No worktree changes.";
      session.hasChanges = diffSummary.trim().length > 0;
      appendSubagentProgress(
        session,
        "status",
        session.hasChanges
          ? "Isolated worktree has changes."
          : "Isolated worktree has no changes."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.diffSummary = `Unable to inspect isolated worktree: ${message}`;
      session.hasChanges = undefined;
      appendSubagentProgress(session, "status", session.diffSummary);
    }
  }

  function getAllowedToolNamesForSubagent(agent: SubagentDefinition) {
    return agent.allowedTools.filter((toolName) =>
      isKnownToolName(toolName) && isToolSchemaAllowedByPolicy(toolName, agent.policy)
    );
  }
}

function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function runGitCommand(args: string[], cwd: string): Promise<string> {
  const result = await runProcess("git", args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function mergePersistedSource<T extends object>(base: Partial<T>, patch: Partial<T>): Partial<T> {
  const next = { ...base } as Partial<T>;

  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value === undefined) {
      delete next[key];
      continue;
    }

    next[key] = value;
  }

  return next;
}

function cloneConnectionConfigState(state: ConnectionConfigState): ConnectionConfigState {
  return {
    effective: { ...state.effective },
    user: { ...state.user },
    project: { ...state.project },
    env: { ...state.env },
    cli: { ...state.cli },
    sources: { ...state.sources },
    saveTarget: state.saveTarget,
    saveTargetPath: state.saveTargetPath,
    userPath: state.userPath,
    projectPath: state.projectPath
  };
}

function cloneSessionSettingsState(state: SessionSettingsState): SessionSettingsState {
  return {
    effective: { ...state.effective },
    project: { ...state.project },
    user: { ...state.user },
    env: { ...state.env },
    cli: { ...state.cli },
    sources: { ...state.sources },
    saveTargetPath: state.saveTargetPath,
    projectPath: state.projectPath
  };
}

function createClientFromConnection(connection: ConnectionConfig): OpenAI | null {
  if (!connection.apiKey.trim()) {
    return null;
  }

  return new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL
  });
}

function createContextBudgetService(settings: SessionSettings): ContextBudgetService {
  return new ContextBudgetService({
    modelContextWindowOverrides: settings.modelContextWindowOverrides
  });
}

function createConversationCompactionConfig(
  settings: SessionSettings
): ConversationCompactionConfig {
  return {
    ...DEFAULT_CONVERSATION_COMPACTION_CONFIG,
    timeoutMs: settings.autoCompactTimeoutMs,
    maxAutoFailures: settings.autoCompactMaxFailures
  };
}

function createSessionMemoryTriggerConfig(
  config: RuntimeConfig,
  settings: SessionSettings
) {
  return {
    ...config.memory.sessionMemory,
    enabled: config.memory.sessionMemory.enabled && settings.sessionMemoryEnabled
  };
}

function createSessionMemoryExtractorConfig(
  config: RuntimeConfig,
  settings: SessionSettings
) {
  return {
    ...config.memory.sessionMemory,
    enabled: config.memory.sessionMemory.enabled && settings.sessionMemoryEnabled
  };
}

function shouldUseGcliGeminiCompat(baseURL: string | undefined, model: string): boolean {
  if (!baseURL) {
    return false;
  }

  if (!model.trim().toLowerCase().startsWith("gemini")) {
    return false;
  }

  try {
    return new URL(baseURL).hostname.toLowerCase() === "gcli.ggchan.dev";
  } catch {
    return false;
  }
}

function normalizeConnectionPatch(
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

function normalizeSettingsPatch(
  patch: Partial<SessionSettings>,
  workspaceRoot: string
): Partial<SessionSettings> {
  const normalized: Partial<SessionSettings> = {};

  if ("approvalMode" in patch) {
    normalized.approvalMode = patch.approvalMode === "auto" ? "auto" : "manual";
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

  if ("markdownMessageRenderingEnabled" in patch) {
    normalized.markdownMessageRenderingEnabled = patch.markdownMessageRenderingEnabled;
  }

  if ("markdownToolMessageRenderingEnabled" in patch) {
    normalized.markdownToolMessageRenderingEnabled = patch.markdownToolMessageRenderingEnabled;
  }

  if ("markdownRenderMaxChars" in patch && patch.markdownRenderMaxChars !== undefined) {
    normalized.markdownRenderMaxChars = Math.max(1, Math.trunc(patch.markdownRenderMaxChars));
  }

  if ("conversationCompactionEnabled" in patch) {
    normalized.conversationCompactionEnabled = patch.conversationCompactionEnabled;
  }

  if ("autoCompactTimeoutMs" in patch) {
    normalized.autoCompactTimeoutMs = patch.autoCompactTimeoutMs;
  }

  if ("autoCompactMaxFailures" in patch) {
    normalized.autoCompactMaxFailures = patch.autoCompactMaxFailures;
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

  return normalized;
}

function normalizeOptionalSessionTextPatch(value: string | undefined): string {
  // 空字符串用于保留“显式清空”语义，避免删除用户层键后回退到项目默认。
  if (value === undefined) {
    return "";
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "";
}

function resolveAllowedRoots(
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

function messagesContainPrefix(
  currentMessages: readonly SessionMessage[],
  expectedPrefix: readonly SessionMessage[]
) {
  if (currentMessages.length < expectedPrefix.length) {
    return false;
  }

  for (let index = 0; index < expectedPrefix.length; index += 1) {
    if (JSON.stringify(currentMessages[index]) !== JSON.stringify(expectedPrefix[index])) {
      return false;
    }
  }

  return true;
}
