import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import type { RuntimeConfig, SessionSettings, ConnectionConfig } from "../../../config/runtime.js";
import {
  ConversationCompactor,
  type ConversationCompactionConfig
} from "../../../core/conversation/conversationCompactor.js";
import type { ContextBudgetService } from "../../../core/context/contextBudget.js";
import { isTurnInterruptedError, throwIfAborted, TurnInterruptedError } from "../../../core/abort.js";
import type { ChatCompletionAdapter } from "../../../core/api/modelAdapters.js";
import { cloneJson } from "../../../core/json/clone.js";
import { buildEffectiveSystemPrompt } from "../../../core/prompt/builder.js";
import { PromptSectionResolver } from "../../../core/prompt/sectionResolver.js";
import type { ResolvedModelProfile } from "../../../core/providers/types.js";
import type { ProjectTrustState } from "../../../core/trust/projectTrustStore.js";
import type { UsageRecordInput } from "../../../core/usage/types.js";
import type {
  SessionHistorySubagentEvent,
  SessionHistorySubagentTaskIndexItem,
  SessionId
} from "../../../core/session-history/types.js";
import { SubagentHistoryStore } from "../../../core/subagent-history/historyStore.js";
import { migrateLegacySubagentTasks } from "../../../core/subagent-history/legacyMigration.js";
import {
  cleanupSubagentStorageArtifacts,
  type SubagentStorageCleanupReport
} from "../../../core/subagent-history/storageCleanup.js";
import { SubagentTaskStorage } from "../../../core/subagent-history/storagePaths.js";
import {
  SUBAGENT_METADATA_VERSION,
  type SubagentMetadataV1,
  type SubagentTranscriptEntry,
  type SubagentTranscriptToolEvent
} from "../../../core/subagent-history/types.js";
import {
  isInternalSubagentType,
  loadSubagentDefinition,
  type SubagentDefinition
} from "../../../tools/AgentTool/agents.js";
import { isToolSchemaAllowedByPolicy } from "../../../tools/toolPolicy.js";
import { isKnownToolName } from "../../../tools/toolNames.js";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  BackgroundProcessManagerLike,
  FileReadState,
  PtyManagerLike,
  SubagentProgressEvent,
  SubagentRunInput,
  SubagentRunResult,
  SubagentTaskInfo,
  SubagentTaskLaunchResult,
  SubagentTaskStatus,
  SubagentTaskStopResult,
  TodoItem,
  ToolApprovalRequest,
  ToolExecutionContext
} from "../../../tools/types.js";
import {
  isGitRepository,
  isPathInsideDirectory,
  pathExists,
  runGitCommand
} from "../helpers/gitPaths.js";
import { resolveSubagentAllowedRoots } from "./allowedRoots.js";
import {
  MAX_SUBAGENT_PROGRESS_DETAIL_CHARS,
  MAX_SUBAGENT_PROGRESS_EVENTS,
  MAX_SUBAGENT_PROGRESS_MESSAGE_CHARS,
  truncateProgressText
} from "./progress.js";
import { prepareResumableSubagentMessages } from "./resumeMessages.js";
import type {
  SubagentPromptInput,
  SubagentSession,
  SubagentSessionMessage
} from "./types.js";

const SUBAGENT_TERMINAL_MEMORY_RETENTION_MS = 30_000;
const SUBAGENT_MEMORY_GC_INTERVAL_MS = 5_000;
const HISTORICAL_SUBAGENT_RUNNING_ERROR = "Task is not running in this process.";

export type SubagentParentContextOptions = {
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
  setTodos: (todos: TodoItem[]) => void | Promise<void>;
  recordToolActivity?: ToolExecutionContext["recordToolActivity"];
};

export interface SubagentRuntimeDeps {
  config: RuntimeConfig;
  getSettings: () => SessionSettings;
  getConnection: () => ConnectionConfig;
  getProjectTrust: () => ProjectTrustState;
  getSessionAdditionalDirectories: () => readonly string[];
  getMessages: () => SubagentSessionMessage[];
  sessionHistory: {
    getCurrentSessionId: () => SessionId;
    recordSubagentEvent: (event: SessionHistorySubagentEvent) => Promise<void>;
  };
  fileReadState: Map<string, FileReadState>;
  backgroundProcessManager: BackgroundProcessManagerLike;
  ptyManager: PtyManagerLike;
  resolveModelProfileFor: (model?: string) => ResolvedModelProfile;
  createModelAdapter: (resolvedModel: ResolvedModelProfile) => ChatCompletionAdapter;
  getPromptRuntimeContext: (options?: {
    availableTools?: string[];
    workspaceRoot?: string;
    allowedRoots?: string[];
    model?: string;
  }) => Promise<Parameters<typeof buildEffectiveSystemPrompt>[0]>;
  captureFileBeforeWrite: (turnId: string, absolutePath: string) => Promise<void>;
  recordUsage: (event: UsageRecordInput) => void;
  createContextBudgetService: (settings: SessionSettings) => ContextBudgetService;
  createConversationCompactionConfig: (settings: SessionSettings) => ConversationCompactionConfig;
}

export interface SubagentRuntime {
  runSubagent: (
    input: SubagentRunInput,
    parentContextOptions: SubagentParentContextOptions
  ) => Promise<SubagentRunResult>;
  launchSubagentTask: (
    input: SubagentRunInput,
    parentContextOptions: Omit<SubagentParentContextOptions, "abortSignal">
  ) => Promise<SubagentTaskLaunchResult>;
  listSubagentTasks: () => SubagentTaskInfo[];
  getSubagentTask: (taskId: string) => Promise<SubagentTaskInfo | undefined>;
  stopSubagentTask: (taskId: string) => Promise<SubagentTaskStopResult>;
  runSubagentStorageCleanup: (options?: { apply?: boolean }) => Promise<SubagentStorageCleanupReport>;
  applySubagentTaskIndex: (
    sessionId: SessionId,
    taskIndex: SessionHistorySubagentTaskIndexItem[]
  ) => void;
  clearTaskIndex: () => void;
  abortRunningSubagentTasks: () => void;
  evictExpiredSubagentSessionsFromMemory: (force?: boolean) => void;
  updateSessionConfigs: (settings: SessionSettings) => void;
  migrateLegacyTasks: () => Promise<void>;
  dispose: () => void;
  getSubagentSessions: () => Map<string, SubagentSession>;
}

async function getToolSchemasByNames(toolNames: readonly string[]) {
  const { getToolSchemasByName } = await import("../../../tools/registry.js");
  return getToolSchemasByName(toolNames);
}

function isUserVisibleSubagentAgentType(agentType: string) {
return !isInternalSubagentType(agentType);
}

export function createSubagentRuntime(deps: SubagentRuntimeDeps): SubagentRuntime {
  const {
    config,
    getSettings,
    getConnection,
    getProjectTrust,
    getSessionAdditionalDirectories,
    getMessages,
    sessionHistory,
    fileReadState,
    backgroundProcessManager,
    ptyManager,
    resolveModelProfileFor,
    createModelAdapter,
    getPromptRuntimeContext,
    captureFileBeforeWrite,
    recordUsage,
    createContextBudgetService,
    createConversationCompactionConfig
  } = deps;

  const subagentSessions = new Map<string, SubagentSession>();
  // 只缓存"当前主会话"的轻量任务索引，用于 TaskList/TaskGet 的跨重启恢复。
  const currentSessionTaskIndex = new Map<string, SessionHistorySubagentTaskIndexItem>();
  const subagentTaskStorage = new SubagentTaskStorage({
    alyceDirectory: config.paths.alyceDirectory,
    getCurrentSessionId: () => sessionHistory.getCurrentSessionId()
  });
  const subagentHistoryStore = new SubagentHistoryStore();
  const getWorktreesDirectory = () =>
    path.join(os.tmpdir(), "alyce-agent-worktrees", sessionHistory.getCurrentSessionId());

  const subagentMemoryGcTimer = setInterval(() => {
    evictExpiredSubagentSessionsFromMemory();
  }, SUBAGENT_MEMORY_GC_INTERVAL_MS);
  subagentMemoryGcTimer.unref?.();

  const buildSubagentSystemPrompt = async (
    input: SubagentPromptInput,
    workspaceRoot = config.paths.workspaceRoot
  ) => {
    const agent = await loadSubagentDefinition(config.paths.workspaceRoot, input.agentType, {
      trustedProject: getProjectTrust().trusted
    });
    if (!agent) {
      throw new Error(`Unknown subagent type: ${input.agentType}`);
    }

    const resolver = new PromptSectionResolver();
    const allowedRoots = resolveSubagentAllowedRoots(
      workspaceRoot,
      agent,
      getSettings(),
      getSessionAdditionalDirectories()
    );
    const basePrompt = await buildEffectiveSystemPrompt(
      await getPromptRuntimeContext({
        availableTools: getAllowedToolNamesForSubagent(agent),
        workspaceRoot,
        allowedRoots,
        model: input.model
      }),
      {
        ...getSettings(),
        appendSystemPrompt: [
          agent.systemPrompt,
          getSettings().appendSystemPrompt?.trim() || ""
        ].filter(Boolean).join("\n\n")
      },
      resolver
    );

    return [
      basePrompt,
      "Subagent assignment summary: the following section defines the subagent's role, task, and reporting contract for this run.",
      "",
      "# Subagent assignment",
      `Subagent type: ${agent.type}`,
      `Task description: ${input.description}`,
      "Return one final report to the parent agent. Do not ask the user directly unless an available question tool is necessary."
    ].join("\n\n");
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
      apiMessageCount: Math.max(0, getMessages().length - 1)
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
      contextBudgetService: createContextBudgetService(getSettings()),
      conversationCompactor: new ConversationCompactor(createConversationCompactionConfig(getSettings()))
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
      progress: session?.progress ?? [],
      ...(session?.worktreePath ? { worktreePath: session.worktreePath } : {}),
      ...(session?.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
      ...(session?.outputPath ?? item.outputPath ? { outputPath: session?.outputPath ?? item.outputPath } : {}),
      ...(session?.diffSummary ? { diffSummary: session.diffSummary } : {}),
      ...(session?.hasChanges !== undefined ? { hasChanges: session.hasChanges } : {})
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
    parentContextOptions: SubagentParentContextOptions
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
    parentContextOptions: Omit<SubagentParentContextOptions, "abortSignal">
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
    const agent = await loadSubagentDefinition(config.paths.workspaceRoot, input.agentType, {
      trustedProject: getProjectTrust().trusted
    });
    if (!agent) {
      throw new Error(`Unknown subagent type: ${input.agentType}`);
    }

    const fallbackModel = input.model ?? agent.model ?? getConnection().model;
    const fallbackConfiguredMaxSteps = input.maxSteps ?? agent.maxSteps ?? getSettings().maxSteps;
    const fallbackMaxSteps = Math.max(1, Math.min(getSettings().maxSteps, fallbackConfiguredMaxSteps));
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

    const configuredMaxSteps = input.maxSteps ?? session.maxSteps ?? agent.maxSteps ?? getSettings().maxSteps;
    const maxSteps = Math.max(1, Math.min(getSettings().maxSteps, configuredMaxSteps));
    const model = input.model ?? session.model ?? agent.model ?? getConnection().model;

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
    parentContextOptions: SubagentParentContextOptions
  ): Promise<string> {
    const agent = await loadSubagentDefinition(config.paths.workspaceRoot, session.agentType, {
      trustedProject: getProjectTrust().trusted
    });
    if (!agent) {
      throw new Error(`Unknown subagent type: ${session.agentType}`);
    }

    const resolvedSubagentModel = resolveModelProfileFor(session.model);
    const clientForSubagent = createModelAdapter(resolvedSubagentModel);

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
          getSettings(),
          getSessionAdditionalDirectories()
        );
      },
      commandTimeoutMs: getSettings().commandTimeoutMs,
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
      backgroundProcessManager,
      ptyManager,
      toolPolicy: agent.policy,
      captureFileBeforeWrite: (absolutePath) =>
        session.activeWorktreePath && isPathInsideDirectory(session.activeWorktreePath, absolutePath)
          ? Promise.resolve()
          : captureFileBeforeWrite(parentContextOptions.turnId, absolutePath),
      recordFileRead: (absolutePath, state) => {
        fileReadState.set(path.resolve(absolutePath), { ...state });
      },
      getFileReadState: (absolutePath) => {
        const state = fileReadState.get(path.resolve(absolutePath));
        return state ? { ...state } : undefined;
      }
    };

    try {
      const { runAgentTurn } = await import("../../../core/agent/runAgentTurn.js");
      const subagentToolSchemas = await getToolSchemasByNames(getAllowedToolNamesForSubagent(agent));
      const output = await runAgentTurn(clientForSubagent, session.messages, {
        model: session.model,
        resolvedModel: resolvedSubagentModel,
        maxSteps: session.maxSteps,
        querySource: "subagent",
        usageSource: "subagent",
        usageTurnId: parentContextOptions.turnId,
        usageTaskId: session.taskId,
        usageLabel: session.agentType,
        onUsage: recordUsage,
        context: subagentContext,
        tools: subagentToolSchemas,
        requestPatches: config.requestPatches,
        contextBudgetService: session.contextBudgetService,
        refreshTools: async () => getToolSchemasByNames(getAllowedToolNamesForSubagent(agent)),
        preflightCompactConversation: async ({ abortSignal, querySource }) => {
          if (querySource === "compact" || querySource === "session_memory") {
            return false;
          }
          return session.conversationCompactor.maybeCompact({
            client: clientForSubagent,
            model: session.model,
            resolvedModel: resolvedSubagentModel,
            messages: session.messages,
            force: true,
            abortSignal,
            onUsage: (event) => recordUsage({
              ...event,
              turnId: parentContextOptions.turnId,
              taskId: session.taskId,
              label: session.agentType
            })
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
        messageTimestampsEnabled: getSettings().messageTimestampsEnabled,
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
      contextBudgetService: createContextBudgetService(getSettings()),
      conversationCompactor: new ConversationCompactor(createConversationCompactionConfig(getSettings()))
    };
    subagentSessions.set(taskId, session);
    return session;
  }

  function listSubagentTasks(): SubagentTaskInfo[] {
    evictExpiredSubagentSessionsFromMemory();
    const merged = new Map<string, SubagentTaskInfo>();

    // 先放入轻量索引，保证"历史任务"在没有活跃内存会话时仍可见。
    for (const item of currentSessionTaskIndex.values()) {
      if (!isUserVisibleSubagentAgentType(item.agentType)) {
        continue;
      }

      merged.set(item.taskId, toSubagentTaskInfoFromIndex(item));
    }

    // 再用内存态覆盖索引态，确保运行中任务和最新状态优先展示。
    for (const session of subagentSessions.values()) {
      if (!isCurrentSessionSubagent(session) || !isUserVisibleSubagentAgentType(session.agentType)) {
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
    if (session && !isUserVisibleSubagentAgentType(session.agentType)) {
      return undefined;
    }
    if (!session) {
      session = getIndexedSubagentSession(taskId);
    }
    if (!session) {
      return undefined;
    }
    if (!isUserVisibleSubagentAgentType(session.agentType)) {
      return undefined;
    }

    await hydrateSubagentSessionFromDisk(session);
    upsertCurrentSessionTaskIndex(session);
    return toSubagentTaskInfo(session);
  }

  async function stopSubagentTask(taskId: string): Promise<SubagentTaskStopResult> {
    const session = subagentSessions.get(taskId);
    if (session && isCurrentSessionSubagent(session)) {
      if (!isUserVisibleSubagentAgentType(session.agentType)) {
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
      if (!isUserVisibleSubagentAgentType(normalizedItem.agentType)) {
        return {
          taskId,
          status: "not_found",
          message: `Unknown subagent task_id: ${taskId}`
        };
      }

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
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
      ...(session.outputPath ? { outputPath: session.outputPath } : {}),
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
    const timestamp = new Date().toISOString();
    session.progress.push({
      timestamp,
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
    session.updatedAt = timestamp;
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

  function buildForkContextMessages(): SubagentSessionMessage[] {
    const compactedSummaryMessages = getMessages()
      .slice(1)
      .filter((message) => message.role === "system");
    const recentConversationMessages = getMessages()
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

  return {
    runSubagent,
    launchSubagentTask,
    listSubagentTasks,
    getSubagentTask,
    stopSubagentTask,
    runSubagentStorageCleanup: async (options = {}) => {
      const report = await cleanupSubagentStorageArtifacts({
        storage: subagentTaskStorage,
        apply: options.apply === true
      });
      evictExpiredSubagentSessionsFromMemory(true);
      return report;
    },
    applySubagentTaskIndex,
    clearTaskIndex: () => {
      currentSessionTaskIndex.clear();
    },
    abortRunningSubagentTasks,
    evictExpiredSubagentSessionsFromMemory,
    updateSessionConfigs: (settings) => {
      for (const session of subagentSessions.values()) {
        session.contextBudgetService.setModelContextWindowOverrides(settings.modelContextWindowOverrides);
        session.conversationCompactor.updateConfig(createConversationCompactionConfig(settings));
      }
    },
    migrateLegacyTasks: async () => {
      await migrateLegacySubagentTasks({
        storage: subagentTaskStorage,
        historyStore: subagentHistoryStore
      }).catch(() => undefined);
    },
    dispose: () => {
      clearInterval(subagentMemoryGcTimer);
    },
    getSubagentSessions: () => subagentSessions
  };
}
