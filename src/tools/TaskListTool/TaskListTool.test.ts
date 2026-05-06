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
