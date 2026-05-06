import assert from "node:assert/strict";
import { executeTaskGetTool } from "./TaskGetTool.js";
import type { SubagentTaskInfo, ToolExecutionContext } from "../types.js";

function createTestContext(
  task: SubagentTaskInfo | undefined,
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
    getSubagentTask: () => task,
    ...patch
  };
}

async function runTests() {
  await testReturnsTaskOutput();
  await testReturnsNotFound();
  await testRequiresRuntimeHook();
  console.log("TaskGet tests passed");
}

async function testReturnsTaskOutput() {
  const result = await executeTaskGetTool({
    task_id: "task-1"
  }, createTestContext({
    taskId: "task-1",
    agentType: "review",
    description: "Review changes",
    model: "test-model",
    maxSteps: 4,
    status: "completed",
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:02:00.000Z",
    startedAt: "2026-05-06T00:00:30.000Z",
    completedAt: "2026-05-06T00:02:00.000Z",
    output: "No issues found.",
    progress: []
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.task_id, "task-1");
  assert.equal((result as { output: string }).output, "No issues found.");
}

async function testReturnsNotFound() {
  const result = await executeTaskGetTool({
    task_id: "missing-task"
  }, createTestContext(undefined));

  assert.equal(result.status, "not_found");
  assert.equal(result.task_id, "missing-task");
}

async function testRequiresRuntimeHook() {
  await assert.rejects(
    executeTaskGetTool({
      task_id: "task-1"
    }, createTestContext(undefined, {
      getSubagentTask: undefined
    })),
    /TaskGet is not available/
  );
}

void runTests();
