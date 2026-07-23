import { randomUUID } from "node:crypto";
import { getFunctionToolNames } from "../../core/api/openaiFunctionTools.js";
import {
  ContextOverflowError,
  isContextOverflowError,
  toContextOverflowError,
  type ContextBudgetSnapshot
} from "../../core/context/contextBudget.js";
import {
  isTurnInterruptedError,
  throwIfAborted,
  TurnInterruptedError
} from "../../core/abort.js";
import type { SessionRuntime } from "../../cli/sessionRuntime.js";
import type { VolatileConversationSnapshot } from "../../cli/sessionRuntime.js";
import { t } from "../../i18n/index.js";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  TodoItem,
  ToolApprovalRequest
} from "../../tools/types.js";
import type { TerminalUiStore } from "../state/store.js";
import type { TerminalUiMessage } from "../state/types.js";
import {
  replaceMessageById,
  setContextBudget,
  setDraftInput,
  setLoading,
  setStatusText,
  setTranscriptSticky
} from "../state/actions.js";
import type { TurnDiffReport } from "../../core/diff/diffService.js";
import {
  createAssistantMessage,
  createErrorMessage,
  createSystemMessage,
  createThinkingMessage,
  createToolResultMessage,
  createUserMessage,
  shouldSkipThinkingContent
} from "./messageMapper.js";
import { extractThinkingDelta, mergeThinkingContent } from "./thinkingText.js";

// Agent turn 执行器：从 sessionController 解耦的“用户消息 -> 模型/工具闭环 -> 历史落盘”主路径。
// sessionController 只负责命令路由、对话框与权限 UI；真正跑一轮 Agent 的逻辑集中在这里。

// 每轮请求在执行前都会记录一个 checkpoint，便于中断时回滚消息和文件改动。
export interface TurnCheckpoint {
  turnId: string;
  input: string;
  createdAt: string;
  uiMessageCount: number;
  volatileSnapshot: VolatileConversationSnapshot;
  controller: AbortController;
  hasAssistantOutput: boolean;
  hasNonRestorableToolActivity: boolean;
  userCancelled: boolean;
}

export type CompletedTurnHistoryPlan = {
  mode: "delta" | "snapshot";
  apiMessages: SessionRuntime["messages"];
  uiBaseMessageCount: number;
};


/** sessionController 注入的宿主能力：避免 runner 直接依赖控制器闭包内部状态。 */
export interface AgentTurnHost {
  store: TerminalUiStore;
  runtime: SessionRuntime;
  appendUiMessage: (message: TerminalUiMessage) => void;
  upsertPagedMessageCache: (message: TerminalUiMessage) => void;
  upsertTurnEphemeralMessage: (
    key: "thinking" | "progress",
    message: TerminalUiMessage
  ) => void;
  resetTurnEphemeralMessages: () => void;
  turnEphemeralMessageIds: Map<"thinking" | "progress", string>;
  requestApproval: (
    request: ToolApprovalRequest,
    options?: { signal?: AbortSignal }
  ) => Promise<boolean>;
  askUserQuestions: (
    request: AskUserQuestionRequest,
    options?: { signal?: AbortSignal }
  ) => Promise<AskUserQuestionResponse>;
  getTodos: () => TodoItem[];
  setTodoItems: (todos: TodoItem[]) => void;
  flushPendingDiagnosticContextMessages: () => void;
  finalizeTurnFileChangesForRewind: (
    checkpoint: TurnCheckpoint,
    postResponseFailures?: string[]
  ) => Promise<TurnDiffReport | null | undefined>;
  appendPostEditSummary: (report: TurnDiffReport | null | undefined) => boolean;
  rememberRewindPoint: (checkpoint: TurnCheckpoint) => void;
  rollbackRuntimeConversationToCheckpoint: (checkpoint: TurnCheckpoint) => Promise<void>;
  syncBackgroundProcesses: () => void;
  setActiveTurn: (checkpoint: TurnCheckpoint | null) => void;
  getActiveTurn: () => TurnCheckpoint | null;
  isExitRequestedAfterTurn: () => boolean;
  clearExitRequestedAfterTurn: () => void;
  finishExit: () => void;
  setDraftInputValue: (value: string) => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatPostResponseFailure(step: string, error: unknown): string {
  return `${step}: ${getErrorMessage(error)}`;
}

export function formatTurnInterruptedMessage(error: unknown, checkpoint: TurnCheckpoint): string {
  const lines = [
    checkpoint.userCancelled || isUserCancelInterrupt(error)
      ? "Request interrupted by user."
      : getErrorMessage(error),
    checkpoint.hasNonRestorableToolActivity
      ? "Some non-rewindable tool side effects may remain on disk."
      : null
  ];

  return lines.filter((line): line is string => line !== null).join("\n");
}

export function isUserCancelInterrupt(error: unknown): boolean {
  return error instanceof TurnInterruptedError &&
    (error.reason === "user-cancel" || error.reason === "user-exit");
}

export function formatContextCompactionMessage(options: {
  compacted: boolean;
  before: ContextBudgetSnapshot;
  after: ContextBudgetSnapshot;
  snippedMessages?: number;
  estimatedTokensSaved?: number;
}) {
  const onlySnipped = !options.compacted &&
    options.snippedMessages !== undefined &&
    options.snippedMessages > 0;
  const lines = [
    onlySnipped
      ? "Older oversized tool output was snipped before sending the model request."
      : options.compacted
        ? "Conversation was compacted before sending the model request."
        : "Alyce checked context before sending the model request, but conversation compaction did not change the prompt.",
    `Before: ${Math.round(options.before.usedPercent)}% used (${options.before.estimatedInputTokens} estimated input tokens).`,
    `After: ${Math.round(options.after.usedPercent)}% used (${options.after.estimatedInputTokens} estimated input tokens).`
  ];

  if (options.snippedMessages && options.snippedMessages > 0) {
    lines.push(
      `Snipped ${options.snippedMessages} oversized tool output message(s), saving about ${options.estimatedTokensSaved ?? 0} estimated tokens.`
    );
  }

  return lines.join("\n");
}

export function getApiMessagesSinceCheckpoint(checkpoint: TurnCheckpoint, runtime: SessionRuntime) {
  const baseLength = checkpoint.volatileSnapshot.messages.length;
  return runtime.messages.slice(Math.min(baseLength, runtime.messages.length));
}

async function recordCompletedTurnHistory(
  runtime: SessionRuntime,
  store: TerminalUiStore,
  plan: CompletedTurnHistoryPlan
) {
  const uiMessages = store.getState().messages.slice(plan.uiBaseMessageCount);
  if (plan.mode === "snapshot") {
    await runtime.recordSessionConversationSnapshot({
      apiMessages: plan.apiMessages,
      uiMessages,
      uiBaseMessageCount: plan.uiBaseMessageCount
    });
    return;
  }

  await runtime.recordSessionTurn({
    apiMessages: plan.apiMessages,
    uiMessages
  });
}

export function formatPromptSkillSummary(
  context: Awaited<ReturnType<SessionRuntime["preparePromptSkillContext"]>>
): string | null {
  const lines: string[] = [];

  if (context.loadedSkillNames.length > 0) {
    lines.push(`Loaded skill context from prompt mentions: ${context.loadedSkillNames.join(", ")}`);
  }

  const unresolvedMentions = context.unresolvedMentions.filter(shouldWarnForUnknownSkillMention);
  if (unresolvedMentions.length > 0) {
    lines.push(
      `Unknown skill mention(s) ignored: ${unresolvedMentions.map((name) => `$${name}`).join(", ")}`
    );
  }

  if (context.disabledMentions.length > 0) {
    lines.push(
      `Disabled skill mention(s) ignored: ${context.disabledMentions.map((name) => `$${name}`).join(", ")}`
    );
  }

  if (context.dependencyWarnings.length > 0) {
    lines.push(...context.dependencyWarnings.slice(0, 5));
  }

  if (context.loadedSkillNames.length > 0 && context.duplicateWarnings.length > 0) {
    lines.push(...context.duplicateWarnings.slice(0, 3));
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function shouldWarnForUnknownSkillMention(name: string) {
  return /-/.test(name) || /[a-z]/.test(name);
}

const RESTORABLE_TOOL_NAMES = new Set([
  "TaskList",
  "TaskGet",
  "Edit",
  "MultiEdit",
  "Write",
  "apply_patch",
  "Bash",
  "PowerShell"
]);

const BACKGROUND_PROCESS_TOOL_NAMES = new Set([
  "ProcessStart",
  "ProcessList",
  "ProcessRead",
  "ProcessStop"
]);

function isBackgroundProcessToolName(toolName: string): boolean {
  return BACKGROUND_PROCESS_TOOL_NAMES.has(toolName);
}


/**
 * 执行一轮用户 Agent turn（不含 slash command 解析）。
 * 调用前请保证：连接已就绪、draft 已清空、busy 检查已通过。
 */
export async function runAgentUserTurn(host: AgentTurnHost, userInput: string): Promise<void> {
    const turnId = randomUUID();
    const controller = new AbortController();
    const checkpoint: TurnCheckpoint = {
      turnId,
      input: userInput,
      createdAt: new Date().toISOString(),
      uiMessageCount: host.store.getState().messages.length,
      volatileSnapshot: host.runtime.createVolatileConversationSnapshot(),
      controller,
      hasAssistantOutput: false,
      hasNonRestorableToolActivity: false,
      userCancelled: false
    };

    // 先立即回显用户消息并进入 preparing，避免回车后卡在“无反馈”状态。
    // snapshot / skills / tools 准备改为并行，缩短输入到模型请求的链路。
    host.setActiveTurn(checkpoint);
    host.resetTurnEphemeralMessages();
    host.store.updateState((state) =>
      setLoading(setStatusText(setTranscriptSticky(state, true), t("status.preparing")), true)
    );
    host.appendUiMessage(createUserMessage(userInput));

    let completedTurnHistoryPlan: CompletedTurnHistoryPlan | null = null;
    let turnRecorded = false;
    let conversationWasCompacted = false;
    let thinkingSnapshot = "";
    let thinkingSegmentContent = "";
    // 流式 assistant 气泡：同一 model step 内原地更新，跨 step 重新开一条。
    let streamingAssistantMessageId: string | null = null;
    let streamingAssistantCreatedAt: string | null = null;
    let streamingAssistantText = "";
    let streamingAssistantFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let postEditSummaryAppended = false;
    const appendPostEditSummaryOnce = (report: TurnDiffReport | null | undefined) => {
      if (postEditSummaryAppended) {
        return;
      }

      postEditSummaryAppended = host.appendPostEditSummary(report);
    };


    /** 流式 UI 合并间隔：过大显得顿，过小会拖垮终端重绘/markdown。 */
    const STREAM_UI_FLUSH_MS = 80;
    let streamRequestStartedAtMs = 0;
    let streamFirstTextAtMs = 0;
    let streamUiFlushCount = 0;
    let streamUiFlushTotalMs = 0;
    let thinkingUiFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const logStreamTiming = (label: string, fields: Record<string, string | number>) => {
      if (process.env.ALYCE_STREAM_TIMING !== "1" && process.env.ALYCE_STREAM_TIMING !== "true") {
        return;
      }
      const detail = Object.entries(fields)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      console.error(`[stream-timing] ${label}${detail ? ` ${detail}` : ""}`);
    };

    const flushStreamingAssistantMessage = (options?: { final?: boolean }) => {
      streamingAssistantFlushTimer = null;
      if (!streamingAssistantText.trim() && !options?.final) {
        return;
      }

      const flushStartedAt = Date.now();
      const nextMessage = createAssistantMessage(streamingAssistantText, {
        ...(streamingAssistantMessageId ? { id: streamingAssistantMessageId } : {}),
        ...(streamingAssistantCreatedAt ? { createdAt: streamingAssistantCreatedAt } : {}),
        streaming: !options?.final
      });
      if (!streamingAssistantMessageId) {
        streamingAssistantMessageId = nextMessage.id;
        streamingAssistantCreatedAt = nextMessage.createdAt;
        host.appendUiMessage(nextMessage);
      } else {
        host.store.updateState((state) => {
          host.upsertPagedMessageCache(nextMessage);
          return replaceMessageById(state, nextMessage.id, nextMessage);
        });
      }

      streamUiFlushCount += 1;
      streamUiFlushTotalMs += Date.now() - flushStartedAt;
    };

    const queueStreamingAssistantDelta = (delta: string) => {
      if (!delta) {
        return;
      }
      streamingAssistantText += delta;
      checkpoint.hasAssistantOutput = true;

      if (streamFirstTextAtMs === 0) {
        streamFirstTextAtMs = Date.now();
        logStreamTiming("ttft", {
          ms: streamFirstTextAtMs - streamRequestStartedAtMs,
          chars: streamingAssistantText.length
        });
        // 首包立刻上屏，后续合并刷新，避免每个 token 卡住 SSE 读取。
        host.store.updateState((state) => setStatusText(state, t("status.responding")));
        if (streamingAssistantFlushTimer !== null) {
          clearTimeout(streamingAssistantFlushTimer);
          streamingAssistantFlushTimer = null;
        }
        // 脱离当前流回调栈，让 chunk 读取优先继续。
        streamingAssistantFlushTimer = setTimeout(() => flushStreamingAssistantMessage(), 0);
        return;
      }

      if (streamingAssistantFlushTimer !== null) {
        return;
      }
      streamingAssistantFlushTimer = setTimeout(
        () => flushStreamingAssistantMessage(),
        STREAM_UI_FLUSH_MS
      );
    };

    const resetStreamingAssistant = () => {
      if (streamingAssistantFlushTimer !== null) {
        clearTimeout(streamingAssistantFlushTimer);
        streamingAssistantFlushTimer = null;
      }
      if (streamingAssistantText.trim()) {
        flushStreamingAssistantMessage({ final: true });
      }
      if (streamRequestStartedAtMs > 0) {
        logStreamTiming("step-summary", {
          ttftMs: streamFirstTextAtMs > 0 ? streamFirstTextAtMs - streamRequestStartedAtMs : -1,
          uiFlushes: streamUiFlushCount,
          uiFlushMs: streamUiFlushTotalMs,
          chars: streamingAssistantText.length
        });
      }
      streamingAssistantMessageId = null;
      streamingAssistantCreatedAt = null;
      streamingAssistantText = "";
      streamRequestStartedAtMs = Date.now();
      streamFirstTextAtMs = 0;
      streamUiFlushCount = 0;
      streamUiFlushTotalMs = 0;
    };

    try {
      // 每轮都绑定独立的 abort controller 和 tool context，确保取消只影响当前轮次。
      const client = host.runtime.requireChatCompletionAdapter();
      const currentModel = host.runtime.getCurrentModel();
      const resolvedModel = host.runtime.getResolvedModelProfile();

      // beginTurn(git snapshot) 与 skills/tools 解析互不依赖，并行执行。
      const [, promptSkillContext, tools] = await Promise.all([
        host.runtime.beginTurn(turnId),
        host.runtime.preparePromptSkillContext(userInput),
        host.runtime.getMainAgentToolSchemas({
          abortSignal: controller.signal
        })
      ]);
      throwIfAborted(controller.signal);

      const userMessage = {
        role: "user",
        content: userInput
      } as const;
      host.runtime.messages.push(...promptSkillContext.generatedMessages, userMessage);
      const promptSkillSummary = formatPromptSkillSummary(promptSkillContext);
      if (promptSkillSummary) {
        host.appendUiMessage(createSystemMessage(promptSkillSummary, "Skills"));
      }

      await host.runtime.resetSystemMessage({
        availableTools: getFunctionToolNames(tools),
        nextUserInput: userInput
      });
      throwIfAborted(controller.signal);

      // 状态栏 Context% 由 runAgentTurn 的 onContextBudget 驱动（preflight / 工具提交 / 最终回复），
      // 不再 fire-and-forget 预估，避免异步结果覆盖更准确的快照。
      host.store.updateState((state) => setStatusText(state, t("status.thinking")));

      const { runAgentTurn } = await import("../../agent.js");
      const reply = await runAgentTurn(client, host.runtime.messages, {
        model: currentModel,
        resolvedModel,
        maxSteps: host.runtime.getSettings().maxSteps,
        querySource: "main",
        messageTimestampsEnabled: host.runtime.getSettings().messageTimestampsEnabled,
        abortSignal: controller.signal,
        usageSource: "main",
        usageTurnId: turnId,
        onUsage: (event) => {
          host.runtime.recordUsage(event);
        },
        context: host.runtime.createToolContext({
          turnId,
          abortSignal: controller.signal,
          requestApproval: host.requestApproval,
          askUserQuestions: host.askUserQuestions,
          getTodos: host.getTodos,
          setTodos: host.setTodoItems,
          recordToolActivity: (toolName) => {
            if (!RESTORABLE_TOOL_NAMES.has(toolName)) {
              checkpoint.hasNonRestorableToolActivity = true;
            }
          }
        }),
        tools,
        requestPatches: host.runtime.requestPatches,
        contextBudgetService: host.runtime.getContextBudgetService(),
        refreshTools: async ({ abortSignal }) => {
          const refreshedTools = await host.runtime.getMainAgentToolSchemas({
            abortSignal
          });
          await host.runtime.resetSystemMessage({
            availableTools: getFunctionToolNames(refreshedTools)
              .sort((left, right) => left.localeCompare(right))
          });
          return refreshedTools;
        },
        preflightCompactConversation: ({ abortSignal, querySource }) =>
          host.runtime.maybeCompactConversation({
            client,
            model: currentModel,
            resolvedModel,
            force: true,
            querySource,
            usageTurnId: turnId,
            abortSignal
          }),
        onContextBudget: (snapshot) => {
          host.store.updateState((state) =>
            setContextBudget(state, snapshot)
          );
        },
        onContextCompactionStart: (snapshot) => {
          host.store.updateState((state) =>
            setContextBudget(setStatusText(state, t("status.compacting")), snapshot)
          );
        },
        onContextCompactionResult: (event) => {
          if (event.compacted || event.snipResult?.changed) {
            conversationWasCompacted = true;
          }

          host.store.updateState((state) =>
            setContextBudget(
              setStatusText(state, t("status.thinking")),
              event.after
            )
          );
          host.appendUiMessage(
            createSystemMessage(
              formatContextCompactionMessage({
                compacted: event.compacted,
                before: event.before,
                after: event.after,
                snippedMessages: event.snipResult?.snippedMessages,
                estimatedTokensSaved: event.snipResult?.estimatedTokensSaved
              }),
              "Context"
            )
          );
        },
        onAssistantStreamStart: () => {
          resetStreamingAssistant();
        },
        onAssistantTextDelta: (delta) => {
          queueStreamingAssistantDelta(delta);
        },
        onAssistantStreamEnd: () => {
          if (streamingAssistantFlushTimer !== null) {
            clearTimeout(streamingAssistantFlushTimer);
            streamingAssistantFlushTimer = null;
          }
          if (streamingAssistantText.trim()) {
            // step 内仍保持 streaming 标记；最终定稿在拿到完整 reply 后处理。
            flushStreamingAssistantMessage();
          }
        },
        onThinking: (thinking) => {
          const chunk = thinking.trim();
          if (!chunk || shouldSkipThinkingContent(chunk)) {
            return;
          }

          const nextThinkingSnapshot = mergeThinkingContent(thinkingSnapshot, chunk);
          if (nextThinkingSnapshot === thinkingSnapshot) {
            return;
          }

          const thinkingDelta = extractThinkingDelta(thinkingSnapshot, nextThinkingSnapshot);
          thinkingSnapshot = nextThinkingSnapshot;
          if (!thinkingDelta.trim()) {
            return;
          }

          const nextThinkingSegmentContent = mergeThinkingContent(thinkingSegmentContent, thinkingDelta);
          if (nextThinkingSegmentContent === thinkingSegmentContent) {
            return;
          }

          thinkingSegmentContent = nextThinkingSegmentContent;
          // 思考流同样合并刷新，避免 reasoning token 把终端打满。
          if (thinkingUiFlushTimer !== null) {
            return;
          }
          thinkingUiFlushTimer = setTimeout(() => {
            thinkingUiFlushTimer = null;
            if (thinkingSegmentContent.trim()) {
              host.upsertTurnEphemeralMessage("thinking", createThinkingMessage(thinkingSegmentContent));
            }
          }, STREAM_UI_FLUSH_MS);
        },
        onReconnect: (event) => {
          if (event.type === "scheduled") {
            const statusLabel = event.statusCode ? `HTTP ${event.statusCode}` : event.errorMessage;
            host.store.updateState((state) =>
              setStatusText(
                state,
                `Reconnecting ${event.attempt}/${event.maxRetries} in ${Math.ceil(
                  event.retryDelayMs / 1000
                )}s... ${statusLabel}`
              )
            );
            return;
          }

          host.store.updateState((state) => setStatusText(state, t("status.thinking")));
        },
        onToolCallStart: (toolName) => {
          if (thinkingUiFlushTimer !== null) {
            clearTimeout(thinkingUiFlushTimer);
            thinkingUiFlushTimer = null;
          }
          if (thinkingSegmentContent.trim().length > 0) {
            host.upsertTurnEphemeralMessage("thinking", createThinkingMessage(thinkingSegmentContent));
            host.turnEphemeralMessageIds.delete("thinking");
            thinkingSegmentContent = "";
          }
          host.store.updateState((state) => setStatusText(state, `Running ${toolName}...`));
        },
        onToolCallResult: (toolName, result, rawArguments) => {
          host.appendUiMessage(createToolResultMessage(toolName, result, rawArguments));
          if (isBackgroundProcessToolName(toolName)) {
            host.syncBackgroundProcesses();
          }
        }
      });

      checkpoint.hasAssistantOutput = true;
      if (streamingAssistantFlushTimer !== null) {
        clearTimeout(streamingAssistantFlushTimer);
        streamingAssistantFlushTimer = null;
      }
      // 流式过程中已展示则原地定稿并去掉 streaming 标记（恢复 markdown）；否则一次性插入。
      if (streamingAssistantMessageId || streamingAssistantText.trim()) {
        streamingAssistantText = reply;
        flushStreamingAssistantMessage({ final: true });
        logStreamTiming("final", {
          ttftMs: streamFirstTextAtMs > 0 ? streamFirstTextAtMs - streamRequestStartedAtMs : -1,
          uiFlushes: streamUiFlushCount,
          uiFlushMs: streamUiFlushTotalMs,
          chars: reply.length
        });
      } else {
        host.appendUiMessage(createAssistantMessage(reply));
      }
      streamingAssistantMessageId = null;
      streamingAssistantCreatedAt = null;
      streamingAssistantText = "";
      completedTurnHistoryPlan = {
        mode: conversationWasCompacted ? "snapshot" : "delta",
        apiMessages: conversationWasCompacted
          ? host.runtime.messages.slice(1)
          : getApiMessagesSinceCheckpoint(checkpoint, host.runtime),
        uiBaseMessageCount: checkpoint.uiMessageCount
      };
      throwIfAborted(controller.signal);
      const postResponseFailures: string[] = [];
      const turnDiffReport = await host.finalizeTurnFileChangesForRewind(
        checkpoint,
        postResponseFailures
      );
      appendPostEditSummaryOnce(turnDiffReport);

      try {
        if (!completedTurnHistoryPlan) {
          throw new Error("Completed turn history was not prepared.");
        }

        await recordCompletedTurnHistory(host.runtime, host.store, completedTurnHistoryPlan);
        turnRecorded = true;
        host.runtime.scheduleSessionMemoryExtraction({
          client,
          model: currentModel,
          resolvedModel,
          querySource: "main",
          usageTurnId: turnId,
          abortSignal: controller.signal
        });
      } catch (error) {
        postResponseFailures.push(formatPostResponseFailure("Session history save failed", error));
      }

      host.rememberRewindPoint(checkpoint);
      host.setActiveTurn(null);
      if (postResponseFailures.length > 0) {
        host.appendUiMessage(createErrorMessage(postResponseFailures.join("\n")));
      }
      // 回合结束后再估一次，确保状态栏与当前 messages 一致（含最终 assistant）。
      try {
        const finalBudget = await host.runtime.estimateContextBudget({
          model: currentModel,
          resolvedModel,
          messages: host.runtime.messages,
          tools
        });
        host.store.updateState((state) =>
          setContextBudget(setStatusText(state, t("status.idle")), finalBudget)
        );
      } catch {
        host.store.updateState((state) => setStatusText(state, t("status.idle")));
      }
    } catch (error) {
      if (checkpoint.hasAssistantOutput) {
        host.setActiveTurn(null);
        const turnDiffReport = await host.finalizeTurnFileChangesForRewind(checkpoint);
        appendPostEditSummaryOnce(turnDiffReport);

        if (!turnRecorded && completedTurnHistoryPlan) {
          try {
            await recordCompletedTurnHistory(host.runtime, host.store, completedTurnHistoryPlan);
            turnRecorded = true;
          } catch (historyError) {
            host.appendUiMessage(
              createErrorMessage(
                `Completed turn was not fully saved: ${getErrorMessage(historyError)}`
              )
            );
          }
        }

        host.rememberRewindPoint(checkpoint);

        if (isTurnInterruptedError(error, controller.signal)) {
          host.appendUiMessage(
            createSystemMessage(
              "Post-response processing was interrupted. The assistant reply was kept.",
              "Session"
            )
          );
          host.store.updateState((state) => setStatusText(state, "Interrupted"));
        } else {
          host.appendUiMessage(
            createErrorMessage(`Post-response processing failed: ${getErrorMessage(error)}`)
          );
          host.store.updateState((state) => setStatusText(state, t("status.idle")));
        }
        return;
      }

      if (isTurnInterruptedError(error, controller.signal)) {
        host.setActiveTurn(null);

        const interruptedUiMessages = host.store.getState().messages.slice(checkpoint.uiMessageCount);
        try {
          if (conversationWasCompacted) {
            await host.runtime.recordSessionConversationSnapshot({
              apiMessages: host.runtime.messages.slice(1),
              uiMessages: interruptedUiMessages,
              uiBaseMessageCount: checkpoint.uiMessageCount
            });
          } else {
            await host.runtime.recordSessionTurn({
              apiMessages: getApiMessagesSinceCheckpoint(checkpoint, host.runtime),
              uiMessages: interruptedUiMessages
            });
          }
          turnRecorded = true;
        } catch (historyError) {
          const historyMessage = getErrorMessage(historyError);
          host.appendUiMessage(createErrorMessage(`Interrupted turn was not saved: ${historyMessage}`));
        }

        const turnDiffReport = await host.finalizeTurnFileChangesForRewind(checkpoint);
        appendPostEditSummaryOnce(turnDiffReport);
        host.rememberRewindPoint(checkpoint);
        host.appendUiMessage(
          createSystemMessage(
            formatTurnInterruptedMessage(error, checkpoint),
            "Session"
          )
        );
        host.store.updateState((state) => setStatusText(state, "Interrupted"));
      } else {
        host.setActiveTurn(null);
        await host.rollbackRuntimeConversationToCheckpoint(checkpoint);
        host.runtime.discardTurn(turnId);
        const contextOverflow = isContextOverflowError(error)
          ? toContextOverflowError(error)
          : null;
        const message = contextOverflow
          ? [
              getErrorMessage(contextOverflow),
              "",
              "This was classified as context_overflow and was not sent through the normal reconnect retry loop.",
              "Use /context to inspect the budget, then compact context or remove large attachments/tool outputs before retrying."
            ].join("\n")
          : getErrorMessage(error);
        host.appendUiMessage(createErrorMessage(message));
        if (contextOverflow instanceof ContextOverflowError && contextOverflow.snapshot) {
          host.store.updateState((state) => setContextBudget(state, contextOverflow.snapshot ?? null));
        }
        host.store.updateState((state) =>
          setDraftInput(setTranscriptSticky(setStatusText(state, t("status.error")), true), checkpoint.input)
        );
      }
    } finally {
      host.flushPendingDiagnosticContextMessages();
      host.resetTurnEphemeralMessages();
      host.store.updateState((state) => setLoading(state, false));

      if (host.isExitRequestedAfterTurn() && host.getActiveTurn() === null && !host.store.getState().isLoading) {
        host.clearExitRequestedAfterTurn();
        host.finishExit();
      }
    }
}
