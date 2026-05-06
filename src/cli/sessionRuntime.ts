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
import { ConversationCompactor, DEFAULT_CONVERSATION_COMPACTION_CONFIG } from "../core/conversation/conversationCompactor.js";
import { MemoryService } from "../core/memory/memoryService.js";
import { FileHistoryManager, type FileHistoryRestoreResult } from "../core/file-history/fileHistoryManager.js";
import { isTurnInterruptedError, throwIfAborted, TurnInterruptedError } from "../core/abort.js";
import type { MemorySnapshot } from "../core/memory/types.js";
import { buildEffectiveSystemPrompt } from "../core/prompt/builder.js";
import { PromptSectionResolver } from "../core/prompt/sectionResolver.js";
import { runAgentTurn } from "../core/agent/runAgentTurn.js";
import { prepareSessionResume } from "../core/session-history/sessionResume.js";
import { SessionHistoryStore } from "../core/session-history/sessionStorage.js";
import type {
  SessionHistoryListItem,
  SessionHistoryRewindMode,
  SessionHistoryUiMessage,
  SessionId,
  SessionResumePayload
} from "../core/session-history/types.js";
import { formatCurrentDateLabel, formatSystemDateTime, getSystemTimeZone } from "../core/time/systemTime.js";
import { getRegisteredToolNames, getToolSchemasByName } from "../tools/registry.js";
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
  normalizePersistedSubagentProgress,
  truncateProgressText
} from "./subagentProgress.js";

export type SessionMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface SubagentSession {
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
  status: SubagentTaskInfo["status"];
  startedAt?: string;
  completedAt?: string;
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
}

interface PersistedSubagentTaskFile {
  version: 1;
  tasks: PersistedSubagentTask[];
}

interface PersistedSubagentTask {
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
  status: SubagentSession["status"];
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  progress?: SubagentProgressEvent[];
  worktreePath?: string;
  diffSummary?: string;
  hasChanges?: boolean;
  isolateWorktree?: boolean;
  baseWorkspaceRoot?: string;
  messages: SessionMessage[];
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
  resetSystemMessage: () => Promise<void>;
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
  recordSessionRewind: (options: {
    apiMessageCount: number;
    uiMessageCount: number;
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
  buildContextPreview: (nextUserInput?: string) => string;
  maybeCompactConversation: (options: {
    client: OpenAI;
    model: string;
    abortSignal?: AbortSignal;
  }) => Promise<boolean>;
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
    "  /remember --session <text>  Save note to session memory only",
    "  /memory            Show memory snapshot",
    "  /memory clear      Clear session memory",
    "  /memory clear --all  Clear session and persistent memory",
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

  if (!snapshot.autoSummaryEnabled) {
    lines.push("Auto summary: (disabled)");
  } else if (!snapshot.autoSummary) {
    lines.push("Auto summary: (not initialized yet)");
  } else {
    lines.push("Auto summary (updated at " + snapshot.autoSummary.updatedAt + "):");
    lines.push(snapshot.autoSummary.markdown);
  }

  if (snapshot.session.length === 0) {
    lines.push("Session memory: (empty)");
  } else {
    lines.push("Session memory:");
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
    DEFAULT_CONVERSATION_COMPACTION_CONFIG
  );
  const sessionHistory = new SessionHistoryStore({
    sessionsDirectory: path.join(config.paths.alyceDirectory, "sessions"),
    workspaceRoot: config.paths.workspaceRoot
  });
  const memoryService = new MemoryService({
    workspaceRoot: config.paths.workspaceRoot,
    ...config.memory
  });
  memoryService.setAutoSummaryEnabled(settings.autoSummaryEnabled);
  await memoryService.initialize();
  const fileReadState = new Map<string, FileReadState>();
  const subagentSessions = new Map<string, SubagentSession>();
  const tasksDirectory = path.join(config.paths.alyceDirectory, "tasks");
  const tasksFilePath = path.join(tasksDirectory, "tasks.json");
  const getWorktreesDirectory = () =>
    path.join(os.tmpdir(), "alyce-agent-worktrees", sessionHistory.getCurrentSessionId());
  let subagentTaskPersistQueue: Promise<void> = Promise.resolve();
  await loadPersistedSubagentTasks();

  const getAllowedRootsSnapshot = () =>
    resolveAllowedRoots(config.paths.workspaceRoot, settings, sessionAdditionalDirectories);

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
      availableTools: options.availableTools ?? getRegisteredToolNames(),
      memory: await memoryService.getPromptContext()
    };
  };

  // system prompt 始终由当前模型、环境、工具能力和记忆视图重新生成。
  const buildSystemPrompt = async () =>
    buildEffectiveSystemPrompt(
      await getPromptRuntimeContext(),
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
  const resetSystemMessage = async () => {
    messages[0] = {
      role: "system",
      content: await buildSystemPrompt()
    };
  };

  const resetVolatileConversationState = async () => {
    const interruptedSubagents = abortRunningSubagentTasks();
    memoryService.clearSession();
    conversationCompactor.clear();
    promptResolver.clearSessionCache();
    fileHistoryManager.clearAll();
    fileReadState.clear();
    sessionAdditionalDirectories = [];
    if (interruptedSubagents) {
      await persistSubagentTasks();
    }
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
      memoryService.setAutoSummaryEnabled(settings.autoSummaryEnabled);
      promptResolver.clearSessionCache();
      await persistSettings();
      await resetSystemMessage();
    },
    resetSystemMessage,
    clearConversation: async () => {
      // 清空会话时保留连接与设置，仅重置对话、记忆缓存和文件回滚历史。
      await sessionHistory.flush();
      sessionHistory.startNewSession();
      await resetVolatileConversationState();
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
        uiBaseMessageCount
      });
    },
    recordSessionRewind: async (options) => {
      await sessionHistory.recordRewind(options);
    },
    flushSessionHistory: () => sessionHistory.flush(),
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
    buildContextPreview: (nextUserInput) => {
      const previewTimestamp = formatSystemDateTime(new Date());
      const trimmedInput = nextUserInput?.trim();
      const previewUserMessage: SessionMessage | undefined = trimmedInput
        ? {
            role: "user",
            content: trimmedInput
          }
        : undefined;

      return buildNextTurnContextPreview({
        currentModel: connection.model,
        messages: previewUserMessage ? [...messages, previewUserMessage] : messages,
        messageTimestampsEnabled: settings.messageTimestampsEnabled,
        currentRequestTimestamp: previewTimestamp
      });
    },
    maybeCompactConversation: async ({ client: compactClient, model, abortSignal }) => {
      if (!settings.conversationCompactionEnabled) {
        return false;
      }

      return conversationCompactor.maybeCompact({
        client: compactClient,
        model,
        messages,
        abortSignal
      });
    },
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
      stopSubagentTask: (taskId) => stopSubagentTask(taskId),
      getSubagentDefinition: (type) => loadSubagentDefinition(config.paths.workspaceRoot, type),
      listSubagentDefinitions: () => loadSubagentDefinitions(config.paths.workspaceRoot)
    })
  };

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
      appendSubagentProgress(session, "status", "Subagent completed.");
      await persistSubagentTasks();
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
      appendSubagentProgress(
        session,
        "status",
        `${isInterrupted ? "Subagent interrupted" : "Subagent failed"}: ${session.error}`
      );
      await persistSubagentTasks();
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
      appendSubagentProgress(session, "status", "Background subagent completed.");
      queuePersistSubagentTasks();
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
      appendSubagentProgress(session, "status", `${wasStopped ? "Background subagent stopped" : "Background subagent failed"}: ${session.error}`);
      queuePersistSubagentTasks();
    });
    await persistSubagentTasks();

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

    const configuredMaxSteps = input.maxSteps ?? agent.maxSteps ?? settings.maxSteps;
    const maxSteps = Math.max(1, Math.min(settings.maxSteps, configuredMaxSteps));
    const model = input.model ?? agent.model ?? connection.model;
    const session = await getOrCreateSubagentSession(input, {
      model,
      systemPrompt: await buildSubagentSystemPrompt({
        agentType: input.agentType,
        description: input.description,
        model
      }),
      maxSteps
    });
    if (session.status === "running" && session.promise) {
      throw new Error(`Subagent task_id ${session.taskId} is already running.`);
    }

    const now = new Date().toISOString();
    const isExistingSession = session.startedAt !== undefined;
    const runToken = randomUUID();

    session.messages.push({
      role: "user",
      content: input.prompt
    });
    session.description = input.description;
    session.model = input.model ?? agent.model ?? session.model;
    session.maxSteps = maxSteps;
    session.status = "running";
    session.error = undefined;
    session.output = undefined;
    session.completedAt = undefined;
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
    await persistSubagentTasks();

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
      queuePersistSubagentTasks();
    };
    session.messages[0] = {
      role: "system",
      content: await buildSubagentSystemPrompt({
        agentType: session.agentType,
        description: session.description,
        model: session.model
      }, workspaceRoot)
    };

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
      return await runAgentTurn(clientForSubagent, session.messages, {
        model: session.model,
        maxSteps: session.maxSteps,
        context: subagentContext,
        tools: getToolSchemasByName(getAllowedToolNamesForSubagent(agent)),
        requestPatches: config.requestPatches,
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
        },
        onToolCallResult: (toolName, result, rawArguments) => {
          recordProgress("tool_result", `Finished ${toolName}`, {
            toolName,
            rawArguments,
            result
          });
        }
      });
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
      const existing = subagentSessions.get(input.taskId);
      if (!existing) {
        throw new Error(`Unknown subagent task_id: ${input.taskId}`);
      }

      if (existing.agentType !== input.agentType) {
        throw new Error(
          `Subagent task_id ${input.taskId} belongs to ${existing.agentType}, not ${input.agentType}.`
        );
      }

      return existing;
    }

    const taskId = randomUUID();
    const now = new Date().toISOString();
    const session: SubagentSession = {
      taskId,
      agentType: input.agentType,
      description: input.description,
      model: options.model,
      maxSteps: options.maxSteps,
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
      ]
    };
    subagentSessions.set(taskId, session);
    await persistSubagentTasks();
    return session;
  }

  function listSubagentTasks(): SubagentTaskInfo[] {
    return [...subagentSessions.values()]
      .map(toSubagentTaskInfo)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function getSubagentTask(taskId: string): SubagentTaskInfo | undefined {
    const session = subagentSessions.get(taskId);
    return session ? toSubagentTaskInfo(session) : undefined;
  }

  async function stopSubagentTask(taskId: string): Promise<SubagentTaskStopResult> {
    const session = subagentSessions.get(taskId);
    if (!session) {
      return {
        taskId,
        status: "not_found",
        message: `Unknown subagent task_id: ${taskId}`
      };
    }

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
    appendSubagentProgress(session, "status", "Subagent task stop requested.");
    await persistSubagentTasks();

    return {
      taskId,
      status: session.status,
      message: "Stop requested for background subagent task.",
      stopRequested: true,
      task: toSubagentTaskInfo(session)
    };
  }

  function abortRunningSubagentTasks() {
    let interrupted = false;
    for (const session of subagentSessions.values()) {
      if (session.status !== "running") {
        continue;
      }

      interrupted = true;
      session.controller?.abort("session-reset");
      const now = new Date().toISOString();
      session.status = "failed";
      session.error = "Subagent task was interrupted by session reset.";
      session.completedAt = now;
      session.updatedAt = now;
      session.controller = undefined;
      session.promise = undefined;
      session.runToken = randomUUID();
      appendSubagentProgress(session, "status", "Subagent task interrupted by session reset.");
    }

    return interrupted;
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

  async function loadPersistedSubagentTasks() {
    let parsed: PersistedSubagentTaskFile;
    try {
      const raw = await fs.readFile(tasksFilePath, "utf8");
      parsed = JSON.parse(raw) as PersistedSubagentTaskFile;
    } catch {
      return;
    }

    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      return;
    }

    let migrated = false;
    for (const task of parsed.tasks) {
      if (!isPersistedSubagentTask(task)) {
        continue;
      }

      const wasRunning = task.status === "running";
      const restoredSession: SubagentSession = {
        taskId: task.taskId,
        agentType: task.agentType,
        description: task.description,
        model: task.model,
        maxSteps: task.maxSteps,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        status: wasRunning ? "failed" : task.status,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        output: task.output,
        error: wasRunning
          ? "Subagent task was interrupted because Alyce restarted."
          : task.error,
        progress: normalizePersistedSubagentProgress(task.progress),
        worktreePath: task.worktreePath,
        diffSummary: task.diffSummary,
        hasChanges: task.hasChanges,
        isolateWorktree: task.isolateWorktree,
        baseWorkspaceRoot: task.baseWorkspaceRoot,
        messages: task.messages
      };

      if (wasRunning) {
        restoredSession.completedAt = new Date().toISOString();
        appendSubagentProgress(
          restoredSession,
          "status",
          "Subagent task marked failed because Alyce restarted before it completed."
        );
        migrated = true;
      }

      subagentSessions.set(task.taskId, restoredSession);
    }

    if (migrated) {
      queuePersistSubagentTasks();
    }
  }

  async function persistSubagentTasks() {
    const payload = createPersistedSubagentTaskPayload();

    subagentTaskPersistQueue = subagentTaskPersistQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(tasksDirectory, { recursive: true });
        await fs.writeFile(tasksFilePath, JSON.stringify(payload, null, 2), "utf8");
      });

    await subagentTaskPersistQueue;
  }

  function queuePersistSubagentTasks() {
    void persistSubagentTasks().catch(() => undefined);
  }

  function createPersistedSubagentTaskPayload(): PersistedSubagentTaskFile {
    return {
      version: 1,
      tasks: [...subagentSessions.values()].map((session) => ({
        taskId: session.taskId,
        agentType: session.agentType,
        description: session.description,
        model: session.model,
        maxSteps: session.maxSteps,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: session.status,
        ...(session.startedAt ? { startedAt: session.startedAt } : {}),
        ...(session.completedAt ? { completedAt: session.completedAt } : {}),
        ...(session.output !== undefined ? { output: session.output } : {}),
        ...(session.error !== undefined ? { error: session.error } : {}),
        ...(session.progress.length > 0 ? { progress: session.progress } : {}),
        ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
        ...(session.diffSummary ? { diffSummary: session.diffSummary } : {}),
        ...(session.hasChanges !== undefined ? { hasChanges: session.hasChanges } : {}),
        ...(session.isolateWorktree !== undefined ? { isolateWorktree: session.isolateWorktree } : {}),
        ...(session.baseWorkspaceRoot ? { baseWorkspaceRoot: session.baseWorkspaceRoot } : {}),
        messages: session.messages
      }))
    };
  }

  function buildForkContextMessages(): SessionMessage[] {
    const forkedMessages = messages
      .slice(1)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-12);

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
    appendSubagentProgress(session, "status", `Created isolated git worktree: ${worktreePath}`);
    await persistSubagentTasks();
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
      await persistSubagentTasks();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.diffSummary = `Unable to inspect isolated worktree: ${message}`;
      session.hasChanges = undefined;
      appendSubagentProgress(session, "status", session.diffSummary);
      await persistSubagentTasks();
    }
  }

  function getAllowedToolNamesForSubagent(agent: SubagentDefinition) {
    return agent.allowedTools.filter((toolName) =>
      isKnownToolName(toolName) && isToolSchemaAllowedByPolicy(toolName, agent.policy)
    );
  }
}

function isPersistedSubagentTask(value: unknown): value is PersistedSubagentTask {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<PersistedSubagentTask>;
  return typeof record.taskId === "string" &&
    typeof record.agentType === "string" &&
    typeof record.description === "string" &&
    typeof record.model === "string" &&
    typeof record.maxSteps === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    isPersistedSubagentStatus(record.status) &&
    Array.isArray(record.messages);
}

function isPersistedSubagentStatus(value: unknown): value is SubagentSession["status"] {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped";
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

  if ("autoSummaryEnabled" in patch) {
    normalized.autoSummaryEnabled = patch.autoSummaryEnabled;
  }

  if ("messageTimestampsEnabled" in patch) {
    normalized.messageTimestampsEnabled = patch.messageTimestampsEnabled;
  }

  if ("markdownMessageRenderingEnabled" in patch) {
    normalized.markdownMessageRenderingEnabled = patch.markdownMessageRenderingEnabled;
  }

  if ("conversationCompactionEnabled" in patch) {
    normalized.conversationCompactionEnabled = patch.conversationCompactionEnabled;
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
