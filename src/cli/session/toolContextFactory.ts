import path from "node:path";
import type { RuntimeConfig, SessionSettings } from "../../config/runtime.js";
import type { PlanModeState } from "../../core/planMode/planMode.js";
import type { ProjectTrustState } from "../../core/trust/projectTrustStore.js";
import type { SessionId } from "../../core/session-history/types.js";
import type { SessionHistorySubagentEvent } from "../../core/session-history/types.js";
import type { McpToolRuntime } from "../../mcp/types.js";
import type {
  BackgroundProcessManagerLike,
  FileReadState,
  PtyManagerLike,
  SubagentTaskInfo,
  ToolExecutionContext
} from "../../tools/types.js";
import {
  loadSubagentDefinition,
  loadSubagentDefinitions
} from "../../tools/AgentTool/agents.js";
import { resolveAllowedRoots } from "./helpers/index.js";
import type { TurnHistoryController } from "./turnHistoryController.js";
import type { SubagentRuntime } from "./subagent/createSubagentRuntime.js";
import type { SessionMessage, SessionRuntime } from "./types.js";

export interface ToolContextFactoryDeps {
  config: RuntimeConfig;
  getSettings: () => SessionSettings;
  getProjectTrust: () => ProjectTrustState;
  getPlanModeState: () => PlanModeState;
  getSessionAdditionalDirectories: () => readonly string[];
  getMessages: () => SessionMessage[];
  fileReadState: Map<string, FileReadState>;
  backgroundProcessManager: BackgroundProcessManagerLike;
  ptyManager: PtyManagerLike;
  mcpRuntime: McpToolRuntime;
  turnHistoryController: TurnHistoryController;
  subagentRuntime: SubagentRuntime;
  sessionHistory: {
    getCurrentSessionId: () => SessionId;
    recordSubagentEvent: (event: SessionHistorySubagentEvent) => Promise<void>;
  };
}

export function createToolContextFactory(
  deps: ToolContextFactoryDeps
): SessionRuntime["createToolContext"] {
  const {
    config,
    getSettings,
    getProjectTrust,
    getPlanModeState,
    getSessionAdditionalDirectories,
    getMessages,
    fileReadState,
    backgroundProcessManager,
    ptyManager,
    mcpRuntime,
    turnHistoryController,
    subagentRuntime,
    sessionHistory
  } = deps;

  return ({
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
    trustedProject: getProjectTrust().trusted,
    get allowedRoots() {
      return resolveAllowedRoots(
        config.paths.workspaceRoot,
        getSettings(),
        getSessionAdditionalDirectories()
      );
    },
    commandTimeoutMs: getSettings().commandTimeoutMs,
    planMode: getPlanModeState().enabled,
    turnId,
    abortSignal,
    requestApproval: (request) => requestApproval(request, { signal: abortSignal }),
    askUserQuestions,
    getTodos,
    setTodos,
    recordToolActivity,
    backgroundProcessManager,
    ptyManager,
    mcpRuntime,
    captureFileBeforeWrite: (absolutePath) =>
      turnHistoryController.captureFileBeforeWrite(turnId, absolutePath),
    recordFileRead: (absolutePath, state) => {
      fileReadState.set(path.resolve(absolutePath), { ...state });
    },
    getFileReadState: (absolutePath) => {
      const state = fileReadState.get(path.resolve(absolutePath));
      return state ? { ...state } : undefined;
    },
    runSubagent: (input) => subagentRuntime.runSubagent(input, {
      turnId,
      abortSignal,
      requestApproval,
      askUserQuestions,
      getTodos,
      setTodos,
      recordToolActivity
    }),
    launchSubagentTask: (input) => subagentRuntime.launchSubagentTask(input, {
      turnId,
      requestApproval,
      askUserQuestions,
      getTodos,
      setTodos,
      recordToolActivity
    }),
    listSubagentTasks: () => subagentRuntime.listSubagentTasks(),
    getSubagentTask: (taskId) => subagentRuntime.getSubagentTask(taskId),
    recordSubagentTaskRetrieved: async (taskId, task) => {
      const session = subagentRuntime.getSubagentSessions().get(taskId);
      if (!session || session.parentSessionId !== sessionHistory.getCurrentSessionId()) {
        return;
      }

      try {
        await sessionHistory.recordSubagentEvent({
          type: "subagent-retrieved",
          taskId: session.taskId,
          agentType: session.agentType,
          description: session.description,
          model: session.model,
          maxSteps: session.maxSteps,
          status: session.status,
          message: `Task output retrieved via TaskGet. Status: ${task.status}, agent: ${task.agentType}.`,
          ...(session.error ? { error: session.error } : {}),
          ...(session.outputPath ? { outputPath: session.outputPath } : {}),
          ...(session.startedAt ? { startedAt: session.startedAt } : {}),
          ...(session.completedAt ? { completedAt: session.completedAt } : {}),
          apiMessageCount: Math.max(0, getMessages().length - 1)
        });
      } catch {
        // Retrieval logging is best-effort and must not fail TaskGet.
      }
    },
    stopSubagentTask: (taskId) => subagentRuntime.stopSubagentTask(taskId),
    getSubagentDefinition: (type) => loadSubagentDefinition(
      config.paths.workspaceRoot,
      type,
      { trustedProject: getProjectTrust().trusted }
    ),
    listSubagentDefinitions: () => loadSubagentDefinitions(
      config.paths.workspaceRoot,
      { trustedProject: getProjectTrust().trusted }
    )
  });
}
