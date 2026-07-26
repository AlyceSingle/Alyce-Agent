import process from "node:process";
import path from "node:path";
import type OpenAI from "openai";
import type { RuntimeConfig, SessionSettings, ConnectionConfig } from "../../config/runtime.js";
import type { ConversationCompactor } from "../../core/conversation/conversationCompactor.js";
import type { ContextBudgetService, ContextBudgetSnapshot } from "../../core/context/contextBudget.js";
import type { MemoryService } from "../../core/memory/memoryService.js";
import type { SessionMemoryFileState } from "../../core/memory/types.js";
import type {
  SessionMemoryExtractor
} from "../../core/memory/sessionMemoryExtractor.js";
import type {
  SessionMemoryTrigger
} from "../../core/memory/sessionMemoryTrigger.js";
import { createSkillContextMessage } from "../../core/api/generatedMessages.js";
import type {
  ChatCompletionTransport
} from "../../core/api/modelAdapters.js";
import { getFunctionToolNames } from "../../core/api/openaiFunctionTools.js";
import { cloneJson } from "../../core/json/clone.js";
import { buildEffectiveSystemPrompt } from "../../core/prompt/builder.js";
import { PromptSectionResolver } from "../../core/prompt/sectionResolver.js";
import type { ResolvedModelProfile } from "../../core/providers/types.js";
import {
  isToolAllowedInPlanMode,
  PLAN_MODE_SYSTEM_INSTRUCTIONS,
  type PlanModeState
} from "../../core/planMode/planMode.js";
import type { AgentQuerySource } from "../../core/agent/querySource.js";
import type { UsageRecordInput } from "../../core/usage/types.js";
import type { SessionId } from "../../core/session-history/types.js";
import {
  collectGitStatusContext,
  type GitStatusPromptContext
} from "../../core/startup/gitStatusContext.js";
import { formatSystemDateTime, getSystemTimeZone } from "../../core/time/systemTime.js";
import type {
  McpToolRuntime
} from "../../mcp/types.js";
import {
  type SkillActivationContext,
  type SkillCatalog,
  type SkillConfigMutationResult,
  type SkillDescriptor,
  type SkillReference,
  SkillService,
  extractPathMentions,
  extractSkillMentions,
  formatSkillContentMessage
} from "../../skills/service.js";
import {
  collectSkillDependencyNotices,
  formatSkillDependencyNotices
} from "../../skills/dependencies.js";
import { getUserHomeFromAlyceDirectory } from "../../core/trust/projectTrustStore.js";
import { KNOWN_TOOL_NAMES } from "../../tools/toolNames.js";
import type { FileReadState } from "../../tools/types.js";
import {
  getCurrentDateLabel,
  messagesContainPrefix,
  resolveAllowedRoots
} from "./helpers/index.js";

export type SessionMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface PromptRuntimeContextOptions {
  availableTools?: string[];
  workspaceRoot?: string;
  allowedRoots?: string[];
  model?: string;
  skillActivationContext?: SkillActivationContext;
  nextUserInput?: string;
}

export interface PreparedPromptSkillContext {
  generatedMessages: SessionMessage[];
  loadedSkillNames: string[];
  unresolvedMentions: string[];
  disabledMentions: string[];
  duplicateWarnings: string[];
  dependencyWarnings: string[];
}

export interface PromptRuntimeDeps {
  config: RuntimeConfig;
  getSettings: () => SessionSettings;
  getConnection: () => ConnectionConfig;
  getProjectTrusted: () => boolean;
  getPlanModeState: () => PlanModeState;
  getSessionAdditionalDirectories: () => readonly string[];
  getMessages: () => SessionMessage[];
  fileReadState: Map<string, FileReadState>;
  memoryService: MemoryService;
  mcpRuntime: McpToolRuntime;
  contextBudgetService: ContextBudgetService;
  conversationCompactor: ConversationCompactor;
  sessionMemoryTrigger: SessionMemoryTrigger;
  sessionMemoryExtractor: SessionMemoryExtractor;
  getCurrentSessionId: () => SessionId;
  recordSessionMemory: (sessionMemory?: SessionMemoryFileState | null) => Promise<void>;
  recordUsage: (event: UsageRecordInput) => void;
  resolveModelProfileFor: (model?: string) => ResolvedModelProfile;
  onAfterSkillsChange: () => Promise<void>;
}

export interface PromptRuntime {
  getMainAgentToolSchemas: (
    options?: { abortSignal?: AbortSignal }
  ) => Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  getToolNamesFromSchemas: (
    tools: OpenAI.Chat.Completions.ChatCompletionTool[]
  ) => string[];
  getPromptRuntimeContext: (
    options?: PromptRuntimeContextOptions
  ) => Promise<Parameters<typeof buildEffectiveSystemPrompt>[0]>;
  preparePromptSkillContext: (input: string) => Promise<PreparedPromptSkillContext>;
  buildSystemPrompt: (options?: {
    availableTools?: string[];
    skillActivationContext?: SkillActivationContext;
    nextUserInput?: string;
  }) => Promise<string>;
  buildSkillActivationContext: (nextUserInput?: string) => SkillActivationContext;
  buildContextPreview: (
    nextUserInput?: string,
    options?: { abortSignal?: AbortSignal }
  ) => Promise<string>;
  estimateContextBudget: (options?: {
    messages?: SessionMessage[];
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
    model?: string;
    resolvedModel?: ResolvedModelProfile;
  }) => Promise<ContextBudgetSnapshot>;
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
  clearPromptCache: () => void;
  setProjectTrusted: (trusted: boolean) => void;
  close: () => void;
}

function getBuiltInToolNames() {
  return [...KNOWN_TOOL_NAMES].sort((left, right) => left.localeCompare(right));
}

async function getToolSchemas() {
  const { TOOL_SCHEMAS } = await import("../../tools.js");
  return TOOL_SCHEMAS;
}

export function createPromptRuntime(deps: PromptRuntimeDeps): PromptRuntime {
  const {
    config,
    getSettings,
    getConnection,
    getProjectTrusted,
    getPlanModeState,
    getSessionAdditionalDirectories,
    getMessages,
    fileReadState,
    memoryService,
    mcpRuntime,
    contextBudgetService,
    conversationCompactor,
    sessionMemoryTrigger,
    sessionMemoryExtractor,
    getCurrentSessionId,
    recordSessionMemory,
    recordUsage,
    resolveModelProfileFor,
    onAfterSkillsChange
  } = deps;

  const promptResolver = new PromptSectionResolver();
  const skillService = new SkillService({
    workspaceRoot: config.paths.workspaceRoot,
    userHomeDirectory: getUserHomeFromAlyceDirectory(config.paths.userAlyceDirectory),
    trustedProject: getProjectTrusted(),
    watch: true
  });

  const getMainAgentToolSchemas = async (options: { abortSignal?: AbortSignal } = {}) => {
    const toolSchemas = await getToolSchemas();
    const planModeEnabled = getPlanModeState().enabled;
    const staticSchemas = planModeEnabled
      ? toolSchemas.filter((tool) => isToolAllowedInPlanMode(tool.function.name))
      : toolSchemas;
    const mcpSchemas = planModeEnabled
      ? []
      : await mcpRuntime.getToolSchemas({
          abortSignal: options.abortSignal,
          initialize: false
        });

    return [
      ...staticSchemas,
      ...mcpSchemas
    ];
  };

  const getToolNamesFromSchemas = (
    tools: OpenAI.Chat.Completions.ChatCompletionTool[]
  ) => getFunctionToolNames(tools).sort((left, right) => left.localeCompare(right));

  const getAvailableToolNamesForPrompt = (availableTools?: string[]) =>
    availableTools ?? getBuiltInToolNames();

  const getRecentOpenedSkillPaths = () =>
    [...fileReadState.entries()]
      .sort((left, right) => {
        const leftTime = Date.parse(left[1].readAt);
        const rightTime = Date.parse(right[1].readAt);
        return rightTime - leftTime;
      })
      .slice(0, 24)
      .map(([absolutePath]) => {
        const relative = path.relative(config.paths.workspaceRoot, absolutePath);
        return relative.startsWith("..") ? absolutePath : relative;
      });

  const buildSkillActivationContext = (nextUserInput?: string): SkillActivationContext => ({
    workspaceRoot: config.paths.workspaceRoot,
    referencedPaths: nextUserInput ? extractPathMentions(nextUserInput) : [],
    openedPaths: getRecentOpenedSkillPaths()
  });

  // git 快照按会话缓存：只在首次构建 prompt 时采集一次，保持 system prompt 稳定（利于前缀缓存）。
  let gitStatusSnapshotPromise: Promise<GitStatusPromptContext | undefined> | undefined;
  const getGitStatusSnapshot = () => {
    gitStatusSnapshotPromise ??= collectGitStatusContext(config.paths.workspaceRoot)
      .catch(() => undefined);
    return gitStatusSnapshotPromise;
  };

  const getPromptRuntimeContext = async (options: PromptRuntimeContextOptions = {}) => {
    const now = new Date();
    const workspaceRoot = options.workspaceRoot ?? config.paths.workspaceRoot;
    const gitStatus = await getGitStatusSnapshot();
    return {
      ...(gitStatus ? { gitStatus } : {}),
      model: options.model ?? getConnection().model,
      workspaceRoot,
      allowedRoots: options.allowedRoots ?? resolveAllowedRoots(
        workspaceRoot,
        getSettings(),
        getSessionAdditionalDirectories()
      ),
      currentDate: getCurrentDateLabel(now),
      currentDateTime: formatSystemDateTime(now),
      timeZone: getSystemTimeZone(),
      platform: process.platform,
      availableTools: getAvailableToolNamesForPrompt(options.availableTools),
      availableSkills: await skillService.buildPromptContext({
        activationContext: options.skillActivationContext ??
          buildSkillActivationContext(options.nextUserInput)
      }),
      memory: await memoryService.getPromptContext()
    };
  };

  const preparePromptSkillContext = async (
    input: string
  ): Promise<PreparedPromptSkillContext> => {
    const mentions = extractSkillMentions(input);
    if (mentions.length === 0) {
      return {
        generatedMessages: [],
        loadedSkillNames: [],
        unresolvedMentions: [],
        disabledMentions: [],
        duplicateWarnings: [],
        dependencyWarnings: []
      };
    }

    const resolution = await skillService.resolveMentionedSkills(input);
    const dependencyWarnings = formatSkillDependencyNotices(
      await collectSkillDependencyNotices(
        resolution.resolvedSkills,
        mcpRuntime,
        { abortSignal: undefined }
      )
    );
    return {
      generatedMessages: resolution.resolvedSkills.map((skill) =>
        createSkillContextMessage(formatSkillContentMessage({
          ...skill,
          dependencyNotes: dependencyWarnings.filter((warning) =>
            warning.includes(`Skill '${skill.name}'`)
          )
        }))
      ),
      loadedSkillNames: resolution.resolvedSkills.map((skill) => skill.name),
      unresolvedMentions: resolution.unresolvedMentions,
      disabledMentions: resolution.disabledMentions,
      duplicateWarnings: resolution.duplicateWarnings,
      dependencyWarnings
    };
  };

  const buildSystemPrompt = async (options: {
    availableTools?: string[];
    skillActivationContext?: SkillActivationContext;
    nextUserInput?: string;
  } = {}) =>
    buildEffectiveSystemPrompt(
      await getPromptRuntimeContext(options),
      {
        ...getSettings(),
        appendSystemPrompt: [
          getPlanModeState().enabled ? PLAN_MODE_SYSTEM_INSTRUCTIONS : "",
          getSettings().appendSystemPrompt?.trim() || ""
        ].filter(Boolean).join("\n\n")
      },
      promptResolver
    );

  const buildContextPreview = async (
    nextUserInput?: string,
    options: { abortSignal?: AbortSignal } = {}
  ) => {
    const previewTimestamp = formatSystemDateTime(new Date());
    const trimmedInput = nextUserInput?.trim();
    const promptSkillContext = trimmedInput
      ? await preparePromptSkillContext(trimmedInput)
      : {
          generatedMessages: [] as SessionMessage[],
          loadedSkillNames: [] as string[],
          unresolvedMentions: [] as string[],
          disabledMentions: [] as string[],
          duplicateWarnings: [] as string[],
          dependencyWarnings: [] as string[]
        };
    const previewUserMessage: SessionMessage | undefined = trimmedInput
      ? {
          role: "user",
          content: trimmedInput
        }
      : undefined;
    const tools = await getMainAgentToolSchemas({
      abortSignal: options.abortSignal
    });
    const messages = getMessages();
    const previewMessages = (
      previewUserMessage
        ? [...messages, ...promptSkillContext.generatedMessages, previewUserMessage]
        : messages
    )
      .map((message) => ({ ...message }));
    previewMessages[0] = {
      role: "system",
      content: await buildSystemPrompt({
        availableTools: getToolNamesFromSchemas(tools),
        skillActivationContext: buildSkillActivationContext(trimmedInput)
      })
    };
    const resolvedModel = resolveModelProfileFor(getConnection().model);

    const { buildNextTurnContextPreview } = await import("../contextPreview.js");
    return buildNextTurnContextPreview({
      currentModel: getConnection().model,
      resolvedModel,
      messages: previewMessages,
      messageTimestampsEnabled: getSettings().messageTimestampsEnabled,
      currentRequestTimestamp: previewTimestamp,
      tools,
      requestPatches: config.requestPatches,
      contextBudgetService
    });
  };

  const estimateContextBudget = async (options: {
    messages?: SessionMessage[];
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
    model?: string;
    resolvedModel?: ResolvedModelProfile;
  } = {}) => {
    const { buildPatchedChatCompletionRequest } = await import("../../core/api/sendChatCompletion.js");
    const model = options.model ?? getConnection().model;
    const resolvedModel = options.resolvedModel ?? resolveModelProfileFor(model);
    return contextBudgetService.estimateRequest(buildPatchedChatCompletionRequest({
      model,
      resolvedModel,
      messages: options.messages ?? getMessages(),
      tools: options.tools ?? [],
      temperature: 0.2,
      toolChoice: "auto",
      messageTimestampsEnabled: getSettings().messageTimestampsEnabled,
      requestPatches: config.requestPatches
    }), {
      resolvedModel
    });
  };

  const maybeCompactConversation = async ({
    client: compactClient,
    model,
    resolvedModel,
    force,
    querySource = "main",
    usageTurnId,
    abortSignal
  }: {
    client: ChatCompletionTransport;
    model: string;
    resolvedModel?: ResolvedModelProfile;
    force?: boolean;
    querySource?: AgentQuerySource;
    usageTurnId?: string;
    abortSignal?: AbortSignal;
  }) => {
    if (!getSettings().conversationCompactionEnabled) {
      return false;
    }
    if (querySource === "compact" || querySource === "session_memory") {
      return false;
    }

    const messages = getMessages();
    const compacted = await conversationCompactor.maybeCompact({
      client: compactClient,
      model,
      resolvedModel: resolvedModel ?? resolveModelProfileFor(model),
      messages,
      force,
      abortSignal,
      onUsage: (event) => recordUsage({
        ...event,
        ...(usageTurnId ? { turnId: usageTurnId } : {})
      })
    });
    if (compacted) {
      fileReadState.clear();
    }
    return compacted;
  };

  const scheduleSessionMemoryExtraction = ({
    client: extractionClient,
    model,
    resolvedModel,
    querySource = "main",
    usageTurnId,
    abortSignal
  }: {
    client: ChatCompletionTransport;
    model: string;
    resolvedModel?: ResolvedModelProfile;
    querySource?: AgentQuerySource;
    usageTurnId?: string;
    abortSignal?: AbortSignal;
  }) => {
    if (querySource !== "main") {
      return;
    }
    void (async () => {
      const messages = getMessages();
      const effectiveResolvedModel = resolvedModel ?? resolveModelProfileFor(model);
      const { buildPatchedChatCompletionRequest } = await import("../../core/api/sendChatCompletion.js");
      const snapshot = contextBudgetService.estimateRequest(buildPatchedChatCompletionRequest({
        model,
        resolvedModel: effectiveResolvedModel,
        messages,
        tools: [],
        temperature: 0.2,
        toolChoice: "auto",
        messageTimestampsEnabled: getSettings().messageTimestampsEnabled,
        requestPatches: config.requestPatches
      }), {
        resolvedModel: effectiveResolvedModel
      });
      const decision = sessionMemoryTrigger.shouldExtract({
        messages,
        currentTokens: snapshot.estimatedInputTokens
      });
      if (!decision.shouldExtract) {
        return;
      }

      const extractionMessages = cloneJson(messages);
      const expectedSessionId = getCurrentSessionId();
      const expectedMessageCount = messages.length;
      const currentTokens = decision.currentTokens;
      const currentMemory = memoryService.getSessionMemory();
      const extraction = sessionMemoryExtractor.schedule({
        client: extractionClient,
        model,
        resolvedModel: effectiveResolvedModel,
        messages: extractionMessages,
        currentMemory: currentMemory?.markdown ?? "",
        memoryPath: memoryService.getSessionMemoryFilePath(),
        requestPatches: config.requestPatches,
        abortSignal,
        onUsage: (event) => recordUsage({
          ...event,
          ...(usageTurnId ? { turnId: usageTurnId } : {})
        }),
        shouldCommit: () =>
          getCurrentSessionId() === expectedSessionId &&
          getMessages().length >= expectedMessageCount
      });
      if (!extraction) {
        return;
      }

      const result = await extraction;
      if (result.status === "updated" && result.markdown) {
        // Background extraction can finish after rewind/resume; commit only
        // when the live conversation still has the exact scheduled prefix.
        const liveMessages = getMessages();
        if (
          getCurrentSessionId() !== expectedSessionId ||
          liveMessages.length < expectedMessageCount ||
          !messagesContainPrefix(liveMessages, extractionMessages)
        ) {
          return;
        }

        memoryService.updateSessionMemory(result.markdown);
        await recordSessionMemory(memoryService.getSessionMemory());
        sessionMemoryTrigger.recordExtraction({
          messages: extractionMessages,
          currentTokens
        });
      }
    })().catch(() => undefined);
  };

  return {
    getMainAgentToolSchemas,
    getToolNamesFromSchemas,
    getPromptRuntimeContext,
    preparePromptSkillContext,
    buildSystemPrompt,
    buildSkillActivationContext,
    buildContextPreview,
    estimateContextBudget,
    maybeCompactConversation,
    scheduleSessionMemoryExtraction,
    listSkills: () => skillService.discoverSkills(),
    getSkill: async (name) => (await skillService.findSkillByName(name, { includeDisabled: true })).skill,
    setSkillEnabled: async (reference, enabled, target) => {
      const result = await skillService.setSkillEnabled(reference, enabled, target);
      await onAfterSkillsChange();
      return result;
    },
    setBundledSkillsEnabled: async (enabled, target) => {
      const result = await skillService.setSkillEnabled({ kind: "bundled" }, enabled, target);
      await onAfterSkillsChange();
      return result;
    },
    refreshSkills: async () => {
      const catalog = await skillService.refresh();
      await onAfterSkillsChange();
      return catalog;
    },
    clearPromptCache: () => promptResolver.clearSessionCache(),
    setProjectTrusted: (trusted) => {
      skillService.setProjectTrusted(trusted);
    },
    close: () => {
      skillService.close();
    }
  };
}
