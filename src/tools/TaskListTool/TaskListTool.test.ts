import assert from "node:assert/strict";
import { executeTaskListTool } from "./TaskListTool.js";
import type { SubagentTaskInfo, ToolExecutionContext } from "../types.js";

function createTestContext(
  tasks: SubagentTaskInfo[],
  patch: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  const abortController = new AbortController();
  return {
    workspaceRoot: process.cwd(),
    allowedRoots: [process.cwd()],
    requestApproval: async () => true,
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined,
    listSubagentTasks: () => tasks,
    ...patch
  };
}

async function runTests() {
  await testListsTasks();
  await testHidesInternalAutoReviewerTasks();
  await testMapsHistoricalTaskFields();
  await testCanHideCompletedTasks();
  await testRequiresRuntimeHook();
  console.log("TaskList tests passed");
}

async function testListsTasks() {
  const result = await executeTaskListTool({}, createTestContext([
    createTask("task-1", "running"),
    createTask("task-2", "completed", { output: "done" })
  ]));

  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0]?.task_id, "task-1");
  assert.equal(result.tasks[1]?.has_output, true);
}

async function testHidesInternalAutoReviewerTasks() {
  const result = await executeTaskListTool({}, createTestContext([
    createTask("task-visible", "running"),
    createTask("task-internal", "completed", { agentType: "auto-reviewer" })
  ]));

  assert.deepEqual(result.tasks.map((task) => task.task_id), ["task-visible"]);
}

async function testCanHideCompletedTasks() {
  const result = await executeTaskListTool({
    include_completed: false
  }, createTestContext([
    createTask("task-1", "running"),
    createTask("task-2", "completed", { output: "done" }),
    createTask("task-3", "failed", { error: "failed" })
  ]));

  assert.deepEqual(result.tasks.map((task) => task.task_id), ["task-1", "task-3"]);
}

async function testMapsHistoricalTaskFields() {
  const result = await executeTaskListTool({}, createTestContext([
    createTask("task-history", "failed", {
      startedAt: "2026-05-06T00:00:05.000Z",
      completedAt: "2026-05-06T00:00:30.000Z",
      error: "Interrupted after resume.",
      worktreePath: "D:/tmp/worktree",
      hasChanges: true,
      output: "partial output",
      progress: [
        {
          timestamp: "2026-05-06T00:00:10.000Z",
          type: "status",
          message: "running"
        },
        {
          timestamp: "2026-05-06T00:00:20.000Z",
          type: "tool_result",
          toolName: "Read",
          result: "ok"
        }
      ]
    })
  ]));

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]?.task_id, "task-history");
  assert.equal(result.tasks[0]?.status, "failed");
  assert.equal(result.tasks[0]?.has_output, true);
  assert.equal(result.tasks[0]?.progress_count, 2);
  assert.equal(result.tasks[0]?.worktree_path, "D:/tmp/worktree");
  assert.equal(result.tasks[0]?.has_changes, true);
  assert.equal(result.tasks[0]?.error, "Interrupted after resume.");
  assert.equal(result.tasks[0]?.started_at, "2026-05-06T00:00:05.000Z");
  assert.equal(result.tasks[0]?.completed_at, "2026-05-06T00:00:30.000Z");
}

async function testRequiresRuntimeHook() {
  await assert.rejects(
    executeTaskListTool({}, createTestContext([], {
      listSubagentTasks: undefined
    })),
    /TaskList is not available/
  );
}

function createTask(
  taskId: string,
  status: SubagentTaskInfo["status"],
  patch: Partial<SubagentTaskInfo> = {}
): SubagentTaskInfo {
  return {
    taskId,
    agentType: "explore",
    description: `Task ${taskId}`,
    model: "test-model",
    maxSteps: 3,
    status,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:01:00.000Z",
    progress: [],
    ...patch
  };
}

void runTests();
