import process from "node:process";
import path from "node:path";
import OpenAI from "openai";
import {
  buildConnectionConfigState,
  buildSessionSettingsState,
  loadRuntimeConfig,
  saveConnectionConfig,
  saveUserSessionSettings,
  type ConnectionConfig,
  type ConnectionConfigSaveTarget,
  type ConnectionConfigState,
  type RuntimeConfig,
  type SessionSettings,
  type SessionSettingsState
} from "../config/runtime.js";
import { MemoryService } from "../core/memory/memoryService.js";
import { FileHistoryManager, type FileHistoryRestoreResult } from "../core/file-history/fileHistoryManager.js";
import type { MemorySnapshot } from "../core/memory/types.js";
import { buildEffectiveSystemPrompt } from "../core/prompt/builder.js";
import { PromptSectionResolver } from "../core/prompt/sectionResolver.js";
import { getRegisteredToolNames } from "../tools/registry.js";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  TodoItem,
  ToolApprovalRequest,
  ToolExecutionContext
} from "../tools/types.js";
import { buildNextTurnContextPreview } from "./contextPreview.js";

export type SessionMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// SessionRuntime 统一封装会话消息、持久化配置、记忆系统和工具执行依赖。
export interface SessionRuntime {
  config: RuntimeConfig;
  memoryService: MemoryService;
  messages: SessionMessage[];
  workspaceRoot: string;
  requestPatches: RuntimeConfig["requestPatches"];
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
  buildContextPreview: (nextUserInput?: string) => string;
  beginTurn: (turnId: string) => void;
  hasTrackedFileChanges: (turnId: string) => boolean;
  restoreFilesForTurn: (turnId: string) => Promise<FileHistoryRestoreResult>;
  discardTurn: (turnId: string) => void;
  createToolContext: (options: {
    turnId: string;
    abortSignal: AbortSignal;
    requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
    askUserQuestions: (
      request: AskUserQuestionRequest,
      options?: { signal?: AbortSignal }
    ) => Promise<AskUserQuestionResponse>;
    getTodos: () => TodoItem[];
    setTodos: (todos: TodoItem[]) => void;
  }) => ToolExecutionContext;
}

export function getCurrentDateLabel(now = new Date()) {
  // 不用 UTC 截日，避免本地时间接近零点时把 prompt 里的日期算错一天。
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getHelpText(currentModel: string) {
  return [
    "Commands:",
    "  /help              Show this help",
    "  /settings          Open runtime settings",
    "  /setup             Open connection setup",
    "  /clear             Clear chat history",
    "  /remember <text>   Save note to session and persistent memory",
    "  /remember --session <text>  Save note to session memory only",
    "  /memory            Show memory snapshot",
    "  /memory clear      Clear session memory",
    "  /memory clear --all  Clear session and persistent memory",
    "  /context [text]    Show full next-turn AI context payload",
    "  /add-dir <path>    Allow access to an extra directory for this session",
    "  /add-dir --save <path>  Add directory and persist it in user settings",
    "  /model <name>      Switch model and persist it (current: " + currentModel + ")",
    "  /exit              Quit",
    "",
    "Shortcuts:",
    "  Ctrl+X  Open settings",
    "  Ctrl+C  Clear current input or quit when empty",
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
  const memoryService = new MemoryService({
    workspaceRoot: config.paths.workspaceRoot,
    ...config.memory
  });
  memoryService.setAutoSummaryEnabled(settings.autoSummaryEnabled);
  await memoryService.initialize();

  // system prompt 始终由当前模型、环境、工具能力和记忆视图重新生成。
  const buildSystemPrompt = async () =>
    buildEffectiveSystemPrompt(
      {
        model: connection.model,
        workspaceRoot: config.paths.workspaceRoot,
        allowedRoots: resolveAllowedRoots(
          config.paths.workspaceRoot,
          settings,
          sessionAdditionalDirectories
        ),
        currentDate: getCurrentDateLabel(),
        platform: process.platform,
        availableTools: getRegisteredToolNames(),
        memory: await memoryService.getPromptContext()
      },
      settings,
      promptResolver
    );

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
    hasConnectionConfig: () => connection.apiKey.trim().length > 0,
    getConnectionConfig: () => ({ ...connection }),
    getConnectionConfigState: () => cloneConnectionConfigState(connectionState),
    getSettings: () => ({ ...settings }),
    getSettingsState: () => cloneSessionSettingsState(settingsState),
    getAllowedRoots: () =>
      resolveAllowedRoots(config.paths.workspaceRoot, settings, sessionAdditionalDirectories),
    getSessionAdditionalDirectories: () => [...sessionAdditionalDirectories],
    setSessionAdditionalDirectories: async (directories) => {
      sessionAdditionalDirectories = normalizeAdditionalDirectories(directories);
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
      const userPatch = normalizeSettingsPatch(patch);
      // 会话设置只回写 user 层；project / env / cli 仍然参与最终覆盖，但不会被保存动作覆盖掉。
      settingsState = buildSessionSettingsState(config.paths, {
        project: settingsState.project,
        user: mergePersistedSource(settingsState.user, userPatch),
        env: settingsState.env,
        cli: settingsState.cli
      });
      settings = settingsState.effective;
      memoryService.setAutoSummaryEnabled(settings.autoSummaryEnabled);
      await persistSettings();
      await resetSystemMessage();
    },
    resetSystemMessage,
    clearConversation: async () => {
      // 清空会话时保留连接与设置，仅重置对话、记忆缓存和文件回滚历史。
      memoryService.clearSession();
      promptResolver.clearSessionCache();
      fileHistoryManager.clearAll();
      messages.splice(1);
      await resetSystemMessage();
    },
    clearPromptCache: () => promptResolver.clearSessionCache(),
    buildContextPreview: (nextUserInput) =>
      buildNextTurnContextPreview({
        currentModel: connection.model,
        messages,
        nextUserInput
      }),
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
      setTodos
    }) => ({
      // 工具在执行前会先登记 turnId，并在写文件前抓取快照，便于中断后回滚。
      workspaceRoot: config.paths.workspaceRoot,
      allowedRoots: resolveAllowedRoots(
        config.paths.workspaceRoot,
        settings,
        sessionAdditionalDirectories
      ),
      commandTimeoutMs: settings.commandTimeoutMs,
      turnId,
      abortSignal,
      requestApproval,
      askUserQuestions,
      getTodos,
      setTodos,
      captureFileBeforeWrite: (absolutePath) => fileHistoryManager.captureBeforeWrite(turnId, absolutePath)
    })
  };
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

function normalizeConnectionPatch(
  patch: Partial<ConnectionConfig>,
  current: ConnectionConfig
): Partial<ConnectionConfig> {
  const normalized: Partial<ConnectionConfig> = {};

  if ("apiKey" in patch) {
    normalized.apiKey = patch.apiKey?.trim() ?? "";
  }

  if ("baseURL" in patch) {
    normalized.baseURL = patch.baseURL?.trim() || undefined;
  }

  if ("model" in patch) {
    normalized.model = patch.model?.trim() || current.model;
  }

  return normalized;
}

function normalizeSettingsPatch(patch: Partial<SessionSettings>): Partial<SessionSettings> {
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

  if ("languagePreference" in patch) {
    normalized.languagePreference = normalizeOptionalSessionTextPatch(patch.languagePreference);
  }

  if ("personaPreset" in patch) {
    normalized.personaPreset = normalizeOptionalSessionTextPatch(patch.personaPreset);
  }

  if ("aiPersonalityPrompt" in patch) {
    normalized.aiPersonalityPrompt = normalizeOptionalSessionTextPatch(patch.aiPersonalityPrompt);
  }

  if ("customSystemPrompt" in patch) {
    normalized.customSystemPrompt = normalizeOptionalSessionTextPatch(patch.customSystemPrompt);
  }

  if ("appendSystemPrompt" in patch) {
    normalized.appendSystemPrompt = normalizeOptionalSessionTextPatch(patch.appendSystemPrompt);
  }

  if ("additionalDirectories" in patch) {
    normalized.additionalDirectories = normalizeAdditionalDirectories(patch.additionalDirectories);
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

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveAllowedRoots(
  workspaceRoot: string,
  settings: SessionSettings,
  sessionAdditionalDirectories: readonly string[]
): string[] {
  const deduped = new Set<string>([path.resolve(workspaceRoot)]);
  for (const directory of settings.additionalDirectories) {
    deduped.add(path.resolve(directory));
  }
  for (const directory of sessionAdditionalDirectories) {
    deduped.add(path.resolve(directory));
  }

  return [...deduped];
}

function normalizeAdditionalDirectories(value: string[] | undefined): string[] {
  if (!value || value.length === 0) {
    return [];
  }

  const deduped = new Set<string>();
  for (const directory of value) {
    const normalized = normalizeOptionalText(directory);
    if (!normalized) {
      continue;
    }

    deduped.add(path.resolve(normalized));
  }

  return [...deduped];
}
