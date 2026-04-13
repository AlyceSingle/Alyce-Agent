import process from "node:process";
import OpenAI from "openai";
import {
  loadRuntimeConfig,
  saveConnectionConfig,
  saveSessionSettings,
  type ConnectionConfig,
  type RuntimeConfig,
  type SessionSettings
} from "../config/runtime.js";
import { MemoryService } from "../core/memory/memoryService.js";
import type { MemorySnapshot } from "../core/memory/types.js";
import { buildEffectiveSystemPrompt } from "../core/prompt/builder.js";
import { PromptSectionResolver } from "../core/prompt/sectionResolver.js";
import { getRegisteredToolNames } from "../tools/registry.js";
import type { ToolApprovalRequest, ToolExecutionContext } from "../tools/types.js";
import { buildNextTurnContextPreview } from "./contextPreview.js";

export type SessionMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface SessionRuntime {
  config: RuntimeConfig;
  memoryService: MemoryService;
  messages: SessionMessage[];
  workspaceRoot: string;
  requestPatches: RuntimeConfig["requestPatches"];
  hasConnectionConfig: () => boolean;
  getConnectionConfig: () => ConnectionConfig;
  getSettings: () => SessionSettings;
  requireClient: () => OpenAI;
  getCurrentModel: () => string;
  setCurrentModel: (model: string) => Promise<void>;
  updateConnectionConfig: (patch: Partial<ConnectionConfig>) => Promise<void>;
  updateSettings: (patch: Partial<SessionSettings>) => Promise<void>;
  resetSystemMessage: () => Promise<void>;
  clearConversation: () => Promise<void>;
  clearPromptCache: () => void;
  buildContextPreview: (nextUserInput?: string) => string;
  createToolContext: (requestApproval: (request: ToolApprovalRequest) => Promise<boolean>) => ToolExecutionContext;
}

export function getCurrentDateLabel() {
  return new Date().toISOString().slice(0, 10);
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
  let connection = config.connection;
  let settings = config.settings;
  let client: OpenAI | null = createClientFromConnection(connection);

  const promptResolver = new PromptSectionResolver();
  const memoryService = new MemoryService({
    workspaceRoot: config.paths.workspaceRoot,
    ...config.memory
  });
  memoryService.setAutoSummaryEnabled(settings.autoSummaryEnabled);
  await memoryService.initialize();

  const buildSystemPrompt = async () =>
    buildEffectiveSystemPrompt(
      {
        model: connection.model,
        workspaceRoot: config.paths.workspaceRoot,
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

  const resetSystemMessage = async () => {
    messages[0] = {
      role: "system",
      content: await buildSystemPrompt()
    };
  };

  const persistConnection = async () => {
    await saveConnectionConfig(config.paths, connection);
  };

  const persistSettings = async () => {
    await saveSessionSettings(config.paths, settings);
  };

  return {
    config,
    memoryService,
    messages,
    workspaceRoot: config.paths.workspaceRoot,
    requestPatches: config.requestPatches,
    hasConnectionConfig: () => connection.apiKey.trim().length > 0,
    getConnectionConfig: () => ({ ...connection }),
    getSettings: () => ({ ...settings }),
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
      connection = {
        ...connection,
        model: model.trim() || connection.model
      };
      await persistConnection();
      await resetSystemMessage();
    },
    updateConnectionConfig: async (patch) => {
      connection = {
        ...connection,
        ...normalizeConnectionPatch(patch, connection)
      };
      client = createClientFromConnection(connection);
      await persistConnection();
      await resetSystemMessage();
    },
    updateSettings: async (patch) => {
      settings = {
        ...settings,
        ...normalizeSettingsPatch(patch)
      };
      memoryService.setAutoSummaryEnabled(settings.autoSummaryEnabled);
      await persistSettings();
      await resetSystemMessage();
    },
    resetSystemMessage,
    clearConversation: async () => {
      memoryService.clearSession();
      promptResolver.clearSessionCache();
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
    createToolContext: (requestApproval) => ({
      workspaceRoot: config.paths.workspaceRoot,
      commandTimeoutMs: settings.commandTimeoutMs,
      requestApproval
    })
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
    normalized.languagePreference = normalizeOptionalText(patch.languagePreference);
  }

  if ("personaPreset" in patch) {
    normalized.personaPreset = normalizeOptionalText(patch.personaPreset);
  }

  if ("aiPersonalityPrompt" in patch) {
    normalized.aiPersonalityPrompt = normalizeOptionalText(patch.aiPersonalityPrompt);
  }

  if ("customSystemPrompt" in patch) {
    normalized.customSystemPrompt = normalizeOptionalText(patch.customSystemPrompt);
  }

  if ("appendSystemPrompt" in patch) {
    normalized.appendSystemPrompt = normalizeOptionalText(patch.appendSystemPrompt);
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
