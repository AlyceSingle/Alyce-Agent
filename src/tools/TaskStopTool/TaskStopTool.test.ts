import assert from "node:assert/strict";
import { executeTaskStopTool } from "./TaskStopTool.js";
import type { SubagentTaskInfo, ToolExecutionContext } from "../types.js";

function createTestContext(
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
    ...patch
  };
}

async function runTests() {
  await testStopsTask();
  await testRecordsOnlyWhenStopRequested();
  await testDoesNotRecordWhenTaskAlreadyFinished();
  await testReturnsHistoricalInterruptedState();
  await testReturnsNotFound();
  await testRequiresRuntimeHook();
  console.log("TaskStop tests passed");
}

async function testStopsTask() {
  const result = await executeTaskStopTool({
    task_id: "task-1"
  }, createTestContext({
    stopSubagentTask: async (taskId) => ({
      taskId,
      status: "stopped",
      message: "stopped",
      task: createTask(taskId, "stopped")
    })
  }));

  assert.equal(result.status, "stopped");
  assert.equal(result.task_id, "task-1");
}

async function testRecordsOnlyWhenStopRequested() {
  const recorded: string[] = [];
  await executeTaskStopTool({
    task_id: "task-1"
  }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    stopSubagentTask: async (taskId) => ({
      taskId,
      status: "stopped",
      message: "stopped",
      stopRequested: true,
      task: createTask(taskId, "stopped")
    })
  }));

  assert.deepEqual(recorded, ["TaskStop"]);
}

async function testDoesNotRecordWhenTaskAlreadyFinished() {
  const recorded: string[] = [];
  const result = await executeTaskStopTool({
    task_id: "task-1"
  }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    stopSubagentTask: async (taskId) => ({
      taskId,
      status: "completed",
      message: "already completed",
      task: createTask(taskId, "completed")
    })
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(recorded, []);
}

async function testReturnsHistoricalInterruptedState() {
  const recorded: string[] = [];
  const result = await executeTaskStopTool({
    task_id: "task-historical-running"
  }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    stopSubagentTask: async (taskId) => ({
      taskId,
      status: "failed",
      message: "Task is no longer running in this process; treating it as interrupted.",
      task: createTask(taskId, "failed", {
        completedAt: "2026-05-06T00:02:00.000Z",
        error: "Interrupted after restart."
      })
    })
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.task_id, "task-historical-running");
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.error, "Interrupted after restart.");
  assert.equal(result.task.completed_at, "2026-05-06T00:02:00.000Z");
  assert.deepEqual(recorded, []);
}

async function testReturnsNotFound() {
  const result = await executeTaskStopTool({
    task_id: "missing"
  }, createTestContext({
    stopSubagentTask: async (taskId) => ({
      taskId,
      status: "not_found",
      message: "missing"
    })
  }));

  assert.equal(result.status, "not_found");
  assert.equal(result.task_id, "missing");
}

async function testRequiresRuntimeHook() {
  await assert.rejects(
    executeTaskStopTool({
      task_id: "task-1"
    }, createTestContext()),
    /TaskStop is not available/
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
    description: "Explore code",
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
