import process from "node:process";
import path from "node:path";
import {
  loadRuntimeConfig,
  normalizeAdditionalDirectories,
  type SessionSettings
} from "../../config/runtime.js";
import {
  getUserHomeFromAlyceDirectory,
  setProjectTrusted,
  type ProjectTrustState
} from "../../core/trust/projectTrustStore.js";
import {
  ConversationCompactor
} from "../../core/conversation/conversationCompactor.js";
import { AuthStore, getAuthStorePath } from "../../core/auth/authStore.js";
import type { PlanModeState } from "../../core/planMode/planMode.js";
import { MemoryService } from "../../core/memory/memoryService.js";
import { SessionMemoryExtractor } from "../../core/memory/sessionMemoryExtractor.js";
import { SessionMemoryTrigger } from "../../core/memory/sessionMemoryTrigger.js";
import { cleanupSnapshotStorage } from "../../core/snapshot/snapshotCleanup.js";
import { cloneJson } from "../../core/json/clone.js";
import { formatUsageReport } from "../../core/usage/formatUsage.js";
import { UsageLedger } from "../../core/usage/usageLedger.js";
import type { UsageRecordInput } from "../../core/usage/types.js";
import { prepareSessionResume } from "../../core/session-history/sessionResume.js";
import { SessionHistoryStore } from "../../core/session-history/sessionStorage.js";
import {
  logStartupTiming,
  measureStartupTiming
} from "../../core/startup/startupTiming.js";
import type { FileReadState } from "../../tools/types.js";
import {
  createContextBudgetService,
  createConversationCompactionConfig,
  createSessionMemoryConfig,
  resolveAllowedRoots
} from "./helpers/index.js";
import { createConnectionController } from "./connectionController.js";
import { createPromptRuntime } from "./promptRuntime.js";
import { createTurnHistoryController } from "./turnHistoryController.js";
import { createSubagentRuntime } from "./subagent/createSubagentRuntime.js";
import {
  createLazyBackgroundProcessManager,
  createLazyModelAdapter,
  createLazyProjectMcpRuntime,
  createLazyPtyManager
} from "./lazyServices.js";
import { createToolContextFactory } from "./toolContextFactory.js";
import type {
  FileReadStateSnapshot,
  SessionMessage,
  SessionRuntime,
  VolatileConversationSnapshot
} from "./types.js";
import type { SkillActivationContext } from "../../skills/service.js";

export async function createSessionRuntime(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<SessionRuntime> {
  logStartupTiming("sessionRuntime:create:start", {
    argvLength: argv.length
  });
  const config = await measureStartupTiming("sessionRuntime:loadRuntimeConfig", () =>
    loadRuntimeConfig(argv, env)
  );
  const authStore = await measureStartupTiming("sessionRuntime:loadAuthStore", () =>
    AuthStore.load(getAuthStorePath(config.paths.userAlyceDirectory))
  );
  let afterConnectionChange: () => Promise<void> = async () => {};
  let afterSettingsChange: (nextSettings: SessionSettings) => Promise<void> = async () => {};
  const connectionController = createConnectionController({
    config,
    env,
    authStore,
    onAfterConnectionChange: () => afterConnectionChange(),
    onAfterSettingsChange: (nextSettings) => afterSettingsChange(nextSettings)
  });
  const getSettings = () => connectionController.getEffectiveSettings();
  const getConnection = () => connectionController.getEffectiveConnection();
  let projectTrust = { ...config.projectTrust };
  let planModeState: PlanModeState = { enabled: false };
  let sessionAdditionalDirectories: string[] = [];
  let latestSnapshotCleanupError: string | undefined;
  const turnHistoryController = createTurnHistoryController({
    config,
    getSettings: () => getSettings(),
    getCurrentSessionId: () => sessionHistory.getCurrentSessionId(),
    recordFileSnapshot: async (snapshot) => {
      await sessionHistory.recordFileSnapshot(snapshot);
    },
    getLatestSnapshotCleanupError: () => latestSnapshotCleanupError
  });
  const conversationCompactor = new ConversationCompactor(
    createConversationCompactionConfig(getSettings())
  );
  const contextBudgetService = createContextBudgetService(getSettings());
  const usageLedger = new UsageLedger({
    jsonlPath: config.paths.usageLogPath
  });
  const backgroundProcessManager = createLazyBackgroundProcessManager({
    workspaceRoot: config.paths.workspaceRoot,
    storageRoot: config.paths.backgroundProcessesDirectory
  });
  const ptyManager = createLazyPtyManager({
    workspaceRoot: config.paths.workspaceRoot
  });
  const sessionMemoryTrigger = new SessionMemoryTrigger(
    createSessionMemoryConfig(config, getSettings())
  );
  const sessionMemoryExtractor = new SessionMemoryExtractor(
    createSessionMemoryConfig(config, getSettings())
  );
  const sessionHistory = new SessionHistoryStore({
    sessionsDirectory: config.paths.sessionsDirectory,
    workspaceRoot: config.paths.workspaceRoot
  });
  const getSessionMemorySourcePath = () =>
    "session history: " +
    path.relative(config.paths.workspaceRoot, sessionHistory.getCurrentSessionFilePath());
  const memoryService = new MemoryService({
    workspaceRoot: config.paths.workspaceRoot,
    ...config.memory
  });
  memoryService.setSessionMemoryEnabled(getSettings().sessionMemoryEnabled);
  memoryService.setSessionMemorySourcePath(getSessionMemorySourcePath());
  const mcpRuntime = createLazyProjectMcpRuntime(
    config.paths.workspaceRoot,
    {
      homeDirectory: getUserHomeFromAlyceDirectory(config.paths.userAlyceDirectory),
      outputDirectory: config.paths.mcpOutputDirectory,
      trusted: projectTrust.trusted
    }
  );
  const fileReadState = new Map<string, FileReadState>();
  let afterSkillsChange: () => Promise<void> = async () => {};
  let messages: SessionMessage[];
  const promptRuntime = createPromptRuntime({
    config,
    getSettings: () => getSettings(),
    getConnection: () => getConnection(),
    getProjectTrusted: () => projectTrust.trusted,
    getPlanModeState: () => planModeState,
    getSessionAdditionalDirectories: () => sessionAdditionalDirectories,
    getMessages: () => messages,
    fileReadState,
    memoryService,
    mcpRuntime,
    contextBudgetService,
    conversationCompactor,
    sessionMemoryTrigger,
    sessionMemoryExtractor,
    getCurrentSessionId: () => sessionHistory.getCurrentSessionId(),
    recordSessionMemory: async (sessionMemory) => {
      await sessionHistory.recordSessionMemory(
        sessionMemory === undefined ? memoryService.getSessionMemory() : sessionMemory
      );
    },
    recordUsage: (event) => recordUsage(event),
    resolveModelProfileFor: (model) => connectionController.resolveModelProfileFor(model),
    onAfterSkillsChange: () => afterSkillsChange()
  });
  const subagentRuntime = createSubagentRuntime({
    config,
    getSettings: () => getSettings(),
    getConnection: () => getConnection(),
    getProjectTrust: () => projectTrust,
    getSessionAdditionalDirectories: () => sessionAdditionalDirectories,
    getMessages: () => messages,
    sessionHistory,
    fileReadState,
    backgroundProcessManager,
    ptyManager,
    resolveModelProfileFor: (model) => connectionController.resolveModelProfileFor(model),
    createModelAdapter: createLazyModelAdapter,
    getPromptRuntimeContext: (options) => promptRuntime.getPromptRuntimeContext(options),
    captureFileBeforeWrite: (turnId, absolutePath) => turnHistoryController.captureFileBeforeWrite(turnId, absolutePath),
    recordUsage: (event) => recordUsage(event),
    createContextBudgetService,
    createConversationCompactionConfig
  });
  // 三个异步操作互不依赖，并行执行以加速启动。
  await Promise.all([
    measureStartupTiming("sessionRuntime:cleanupSnapshotStorage", () =>
      cleanupSnapshotStorage({
        alyceDirectory: config.paths.alyceDirectory,
        retentionDays: getSettings().snapshot.retentionDays,
        apply: true,
        excludePaths: [turnHistoryController.getGitDirectory()]
      }).catch((error: unknown) => {
        latestSnapshotCleanupError = error instanceof Error ? error.message : String(error);
      })
    ),
    measureStartupTiming("sessionRuntime:memoryServiceInitialize", () =>
      memoryService.initialize()
    ),
    measureStartupTiming("sessionRuntime:migrateLegacySubagentTasks", () =>
      subagentRuntime.migrateLegacyTasks()
    )
  ]);
  logStartupTiming("sessionRuntime:create:end", {
    workspaceRoot: config.paths.workspaceRoot,
    snapshotCleanupError: latestSnapshotCleanupError
  });

  const getAllowedRootsSnapshot = () =>
    resolveAllowedRoots(config.paths.workspaceRoot, getSettings(), sessionAdditionalDirectories);

  messages = [
    {
      role: "system",
      content: await promptRuntime.buildSystemPrompt()
    }
  ];

  // 约定 messages[0] 永远保留为 system message，其他消息只追加在其后。
  const resetSystemMessage = async (options: {
    availableTools?: string[];
    skillActivationContext?: SkillActivationContext;
    nextUserInput?: string;
  } = {}) => {
    messages[0] = {
      role: "system",
      content: await promptRuntime.buildSystemPrompt(options)
    };
  };


  afterConnectionChange = async () => {
    await resetSystemMessage();
  };
  afterSkillsChange = async () => {
    await resetSystemMessage();
  };
  afterSettingsChange = async (nextSettings) => {
    contextBudgetService.setModelContextWindowOverrides(nextSettings.modelContextWindowOverrides);
    conversationCompactor.updateConfig(createConversationCompactionConfig(nextSettings));
    sessionMemoryTrigger.updateConfig(createSessionMemoryConfig(config, nextSettings));
    sessionMemoryExtractor.updateConfig(createSessionMemoryConfig(config, nextSettings));
    turnHistoryController.updateSnapshotConfig(nextSettings);
    subagentRuntime.updateSessionConfigs(nextSettings);
    memoryService.setSessionMemoryEnabled(nextSettings.sessionMemoryEnabled);
    promptRuntime.clearPromptCache();
    await resetSystemMessage();
  };

  const resetVolatileConversationState = async () => {
    subagentRuntime.abortRunningSubagentTasks();
    await memoryService.clearSession();
    conversationCompactor.clear();
    promptRuntime.clearPromptCache();
    turnHistoryController.clearAll();
    fileReadState.clear();
    sessionAdditionalDirectories = [];
    sessionMemoryTrigger.clear();
    sessionMemoryExtractor.clear();
    subagentRuntime.evictExpiredSubagentSessionsFromMemory();
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
    promptRuntime.clearPromptCache();
    await resetSystemMessage();
  };

  const recordUsage = (event: UsageRecordInput) => {
    try {
      usageLedger.recordEvent(event);
    } catch {
      // Usage visibility is best-effort and must not affect agent execution.
    }
  };

  const createToolContext = createToolContextFactory({
    config,
    getSettings: () => getSettings(),
    getProjectTrust: () => projectTrust,
    getPlanModeState: () => planModeState,
    getSessionAdditionalDirectories: () => sessionAdditionalDirectories,
    getMessages: () => messages,
    fileReadState,
    backgroundProcessManager,
    ptyManager,
    mcpRuntime,
    turnHistoryController,
    subagentRuntime,
    sessionHistory
  });

  return {
    config,
    memoryService,
    messages,
    workspaceRoot: config.paths.workspaceRoot,
    requestPatches: config.requestPatches,
    getMainAgentToolSchemas: (options) => promptRuntime.getMainAgentToolSchemas(options),
    getSessionId: () => sessionHistory.getCurrentSessionId(),
    getSessionHistoryDirectory: () => config.paths.sessionsDirectory,
    hasConnectionConfig: () => connectionController.hasUsableModelAdapter(),
    getConnectionConfig: () => connectionController.getConnection(),
    getConnectionConfigState: () => connectionController.getConnectionState(),
    getProviderAuthRecords: () => connectionController.getProviderAuthRecords(),
    getAuthStorePath: () => connectionController.getAuthStorePath(),
    getSettings: () => connectionController.getSettings(),
    getSettingsState: () => connectionController.getSettingsState(),
    getProjectTrustState: () => ({ ...projectTrust }),
    setProjectTrusted: async (trusted) => {
      const nextState = await setProjectTrusted(config.paths.workspaceRoot, trusted, {
        userAlyceDirectory: config.paths.userAlyceDirectory
      });
      projectTrust = nextState;
      promptRuntime.setProjectTrusted(trusted);
      await mcpRuntime.setProjectTrusted?.(trusted).catch(() => undefined);
      await resetSystemMessage();
      return { ...nextState };
    },
    getPlanModeState: () => ({ ...planModeState }),
    setPlanModeEnabled: async (enabled) => {
      if (planModeState.enabled === enabled) {
        return { ...planModeState };
      }

      planModeState = {
        enabled,
        ...(enabled ? { enteredAt: new Date().toISOString() } : {})
      };
      promptRuntime.clearPromptCache();
      await resetSystemMessage();
      return { ...planModeState };
    },
    getAllowedRoots: () => getAllowedRootsSnapshot(),
    getSessionAdditionalDirectories: () => [...sessionAdditionalDirectories],
    setSessionAdditionalDirectories: async (directories) => {
      sessionAdditionalDirectories = normalizeAdditionalDirectories(
        directories,
        config.paths.workspaceRoot
      );
      await resetSystemMessage();
    },
    requireChatCompletionAdapter: () => createLazyModelAdapter(connectionController.resolveModelProfileFor()),
    getCurrentModel: () => connectionController.getCurrentModel(),
    getCurrentModelRef: () => connectionController.getCurrentModelRef(),
    getResolvedModelProfile: () => connectionController.resolveModelProfileFor(),
    refreshCurrentProviderModels: () => connectionController.refreshCurrentProviderModels(),
    setCurrentModel: (model) => connectionController.setCurrentModel(model),
    updateConnectionConfig: (patch, target) =>
      connectionController.updateConnectionConfig(patch, target),
    applyProviderConnection: (plan) => connectionController.applyProviderConnection(plan),
    authorizeProviderAuth: (providerId, methodIndex, inputs) =>
      connectionController.authorizeProviderAuth(providerId, methodIndex, inputs),
    completeProviderAuth: (providerId, methodIndex, code, options) =>
      connectionController.completeProviderAuth(providerId, methodIndex, code, options),
    clearProviderAuthFlow: (providerId) => connectionController.clearProviderAuthFlow(providerId),
    removeProviderAuth: (providerId) => connectionController.removeProviderAuth(providerId),
    updateSettings: (patch) => connectionController.updateSettings(patch),
    resetSystemMessage,
    clearConversation: async () => {
      // 清空会话时保留连接与设置，仅重置对话、记忆缓存和文件回滚历史。
      await sessionHistory.flush();
      sessionHistory.startNewSession();
      subagentRuntime.clearTaskIndex();
      await resetVolatileConversationState();
      memoryService.setSessionMemorySourcePath(getSessionMemorySourcePath());
      messages.splice(1);
      await resetSystemMessage();
    },
    clearPromptCache: () => promptRuntime.clearPromptCache(),
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
      subagentRuntime.dispose();
      ptyManager.closeAll();
      promptRuntime.close();
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
      await turnHistoryController.hydrateFileHistoryForSession(resume.sessionId, resume.fileSnapshots);
      subagentRuntime.applySubagentTaskIndex(resume.sessionId, resume.subagentTaskIndex);
      memoryService.setSessionMemory(resume.sessionMemory);
      memoryService.setSessionMemorySourcePath(getSessionMemorySourcePath());
      messages.splice(
        0,
        messages.length,
        {
          role: "system",
          content: await promptRuntime.buildSystemPrompt()
        },
        ...resume.apiMessages
      );
      return resume;
    },
    listSubagentTasks: () => subagentRuntime.listSubagentTasks(),
    getSubagentTask: (taskId) => subagentRuntime.getSubagentTask(taskId),
    stopSubagentTask: (taskId) => subagentRuntime.stopSubagentTask(taskId),
    runSubagent: (input, parentContextOptions) =>
      subagentRuntime.runSubagent(input, parentContextOptions),
    runSubagentStorageCleanup: (options) =>
      subagentRuntime.runSubagentStorageCleanup(options),
    listBackgroundProcesses: (options = {}) =>
      backgroundProcessManager.listProcesses({ includeExited: options.includeExited }),
    stopBackgroundProcess: (processId, options = {}) =>
      backgroundProcessManager.stopProcess(processId, options),
    stopAllBackgroundProcesses: (options = {}) =>
      backgroundProcessManager.stopAll(options),
    listPtySessions: () => ptyManager.listSessions(),
    closeAllPtySessions: () => ptyManager.closeAll(),
    buildContextPreview: (nextUserInput, options) =>
      promptRuntime.buildContextPreview(nextUserInput, options),
    listSkills: () => promptRuntime.listSkills(),
    getSkill: (name) => promptRuntime.getSkill(name),
    setSkillEnabled: (reference, enabled, target) =>
      promptRuntime.setSkillEnabled(reference, enabled, target),
    setBundledSkillsEnabled: (enabled, target) =>
      promptRuntime.setBundledSkillsEnabled(enabled, target),
    refreshSkills: () => promptRuntime.refreshSkills(),
    getMcpStatus: async (options = {}) => await mcpRuntime.getStatus(options),
    listMcpTools: async (options = {}) => await mcpRuntime.listTools(options),
    listMcpResources: async (options = {}) => await mcpRuntime.listResources(options),
    listMcpPrompts: async (options = {}) => await mcpRuntime.listPrompts(options),
    getMcpPrompt: async (serverName, promptName, args = {}, options = {}) =>
      await mcpRuntime.getPrompt(serverName, promptName, args, options),
    listMcpResourceTemplates: async (options = {}) =>
      await mcpRuntime.listResourceTemplates(options),
    addMcpServer: async (name, serverConfig, scope = "project") =>
      await mcpRuntime.addServer(name, serverConfig, { scope }),
    removeMcpServer: async (name, scope = "project") =>
      await mcpRuntime.removeServer(name, { scope }),
    setMcpServerEnabled: async (name, enabled, scope = "project") =>
      await mcpRuntime.setServerEnabled(name, enabled, { scope }),
    loginMcpServer: async (serverName, options = {}) =>
      await mcpRuntime.loginServer(serverName, options),
    setMcpInteractionHandlers: (handlers) => {
      mcpRuntime.setInteractionHandlers?.(handlers);
    },
    preparePromptSkillContext: (input) => promptRuntime.preparePromptSkillContext(input),
    getContextBudgetService: () => contextBudgetService,
    estimateContextBudget: (options) => promptRuntime.estimateContextBudget(options),
    recordUsage,
    formatUsageReport: () => formatUsageReport(usageLedger.getSummary()),
    maybeCompactConversation: (options) => promptRuntime.maybeCompactConversation(options),
    scheduleSessionMemoryExtraction: (options) =>
      promptRuntime.scheduleSessionMemoryExtraction(options),
    createVolatileConversationSnapshot,
    restoreVolatileConversationSnapshot,
    beginTurn: (turnId) => turnHistoryController.beginTurn(turnId),
    finalizeTurnFileChanges: (turnId) => turnHistoryController.finalizeTurnFileChanges(turnId),
    hasTrackedFileChanges: (turnId) => turnHistoryController.hasTrackedFileChanges(turnId),
    canRestoreFilesForTurn: (turnId) => turnHistoryController.canRestoreFilesForTurn(turnId),
    isFilesAlreadyRestoredForTurn: (turnId) =>
      turnHistoryController.isFilesAlreadyRestoredForTurn(turnId),
    restoreFilesForTurn: (turnId) => turnHistoryController.restoreFilesForTurn(turnId),
    discardTurn: (turnId) => turnHistoryController.discardTurn(turnId),
    getTurnDiff: (turnId) => turnHistoryController.getTurnDiff(turnId),
    getLastAlyceTurnDiff: () => turnHistoryController.getLastAlyceTurnDiff(),
    getWorkingTreeDiff: () => turnHistoryController.getWorkingTreeDiff(),
    getSnapshotDiagnostics: () => turnHistoryController.getSnapshotDiagnostics(),
    formatDiffSummary: (report) => turnHistoryController.formatDiffSummary(report),
    createToolContext

  };

}
