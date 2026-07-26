import type { SessionRuntime } from "../../../cli/sessionRuntime.js";
import {
  formatTaskCompletionNotification,
  isTerminalTaskStatus
} from "../../../cli/taskCommand.js";
import type { SubagentTaskInfo } from "../../../tools/types.js";
import { setBackgroundProcessCount, setBackgroundTasks } from "../../state/actions.js";
import type { TerminalUiStore } from "../../state/store.js";
import type { TerminalUiMessage, TerminalUiTaskSummary } from "../../state/types.js";
import { createSystemMessage } from "../messageMapper.js";
import {
  isNotifiableBackgroundTask,
  isVisibleBackgroundProcess,
  isVisibleBackgroundTask
} from "./helpers.js";

const TASK_SYNC_INTERVAL_MS = 1000;

export interface BackgroundActivitySync {
  syncBackgroundTasks: (options?: { notify?: boolean }) => void;
  syncBackgroundProcesses: () => void;
  startTaskSync: () => void;
  stopTaskSync: () => void;
  resetTaskTracking: () => void;
  unreadTaskIds: Set<string>;
}

export function createBackgroundActivitySync(deps: {
  runtime: SessionRuntime;
  store: TerminalUiStore;
  appendUiMessage: (message: TerminalUiMessage) => void;
}): BackgroundActivitySync {
  const { runtime, store, appendUiMessage } = deps;

  let taskSyncTimer: NodeJS.Timeout | null = null;
  let taskSyncInitialized = false;
  let lastTaskSnapshotJson = "";
  let lastBackgroundProcessCount = -1;
  const knownTaskStatuses = new Map<string, SubagentTaskInfo["status"]>();
  const unreadTaskIds = new Set<string>();
  const notifiedTerminalTaskIds = new Set<string>();

  const toTerminalTaskSummary = (task: SubagentTaskInfo): TerminalUiTaskSummary => ({
    taskId: task.taskId,
    agentType: task.agentType,
    description: task.description
  });

  const updateTaskState = (tasks: SubagentTaskInfo[]) => {
    const summaries = tasks.filter(isVisibleBackgroundTask).map(toTerminalTaskSummary);
    const snapshotJson = JSON.stringify(summaries);
    if (snapshotJson === lastTaskSnapshotJson) {
      return;
    }

    lastTaskSnapshotJson = snapshotJson;
    store.updateState((state) => setBackgroundTasks(state, summaries));
  };

  const resetTaskTracking = () => {
    taskSyncInitialized = false;
    lastTaskSnapshotJson = "";
    knownTaskStatuses.clear();
    unreadTaskIds.clear();
    notifiedTerminalTaskIds.clear();
    store.updateState((state) => setBackgroundTasks(state, []));
  };

  const syncBackgroundTasks = (options: { notify?: boolean } = {}) => {
    let tasks: SubagentTaskInfo[];
    try {
      tasks = runtime.listSubagentTasks();
    } catch {
      return;
    }

    const shouldNotify = options.notify !== false && taskSyncInitialized;
    for (const task of tasks) {
      const previousStatus = knownTaskStatuses.get(task.taskId);
      const becameTerminal =
        (previousStatus === "running" || previousStatus === undefined) &&
        isTerminalTaskStatus(task.status) &&
        !notifiedTerminalTaskIds.has(task.taskId);
      const notifiableTask = isNotifiableBackgroundTask(task);

      if (notifiableTask && shouldNotify && becameTerminal) {
        if (task.status === "completed") {
          unreadTaskIds.add(task.taskId);
        }
        notifiedTerminalTaskIds.add(task.taskId);
        appendUiMessage(createSystemMessage(formatTaskCompletionNotification(task), "Task"));
      }

      knownTaskStatuses.set(task.taskId, task.status);
    }

    updateTaskState(tasks);
    taskSyncInitialized = true;
  };

  const syncBackgroundProcesses = () => {
    let processCount: number;
    try {
      processCount = runtime.listBackgroundProcesses().filter(isVisibleBackgroundProcess).length;
    } catch {
      return;
    }

    if (processCount === lastBackgroundProcessCount) {
      return;
    }

    lastBackgroundProcessCount = processCount;
    store.updateState((state) => setBackgroundProcessCount(state, processCount));
  };

  const startTaskSync = () => {
    if (taskSyncTimer) {
      return;
    }

    syncBackgroundTasks({ notify: false });
    syncBackgroundProcesses();
    taskSyncTimer = setInterval(() => {
      syncBackgroundTasks();
      syncBackgroundProcesses();
    }, TASK_SYNC_INTERVAL_MS);
    taskSyncTimer.unref?.();
  };

  const stopTaskSync = () => {
    if (!taskSyncTimer) {
      return;
    }

    clearInterval(taskSyncTimer);
    taskSyncTimer = null;
  };

  return {
    syncBackgroundTasks,
    syncBackgroundProcesses,
    startTaskSync,
    stopTaskSync,
    resetTaskTracking,
    unreadTaskIds
  };
}
