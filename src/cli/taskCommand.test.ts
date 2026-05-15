import assert from "node:assert/strict";
import {
  formatTaskCompletionNotification,
  formatTaskDetails,
  formatTaskList,
  formatTaskStopResult,
  summarizeTaskCounts
} from "./taskCommand.js";
import type { SubagentTaskInfo } from "../tools/types.js";

function runTests() {
  testTaskListShowsCountsAndUnread();
  testTaskDetailsBoundsOutputAndShowsPaths();
  testTaskStopResultHandlesNotFound();
  testCompletionNotificationIncludesResultSummary();
  console.log("taskCommand tests passed");
}

function testTaskListShowsCountsAndUnread() {
  const tasks = [
    createTask("running", { taskId: "running-task" }),
    createTask("completed", { taskId: "complete-task" }),
    createTask("failed", { taskId: "failed-task", error: "boom" })
  ];
  const unread = new Set(["complete-task"]);

  assert.deepEqual(summarizeTaskCounts(tasks, unread), {
    running: 1,
    completedUnread: 1,
    failed: 1
  });

  const report = formatTaskList(tasks, unread);
  assert.match(report, /1 running, 1 unread, 1 failed/);
  assert.match(report, /complete/);
  assert.match(report, /unread/);
}

function testTaskDetailsBoundsOutputAndShowsPaths() {
  const report = formatTaskDetails(
    createTask("completed", {
      output: "x".repeat(5000),
      transcriptPath: "transcript.jsonl",
      outputPath: "output.md",
      progress: [{ timestamp: "2026-01-01T00:00:00.000Z", type: "status", message: "done" }]
    }),
    "task-1"
  );

  assert.match(report, /Transcript: transcript\.jsonl/);
  assert.match(report, /Output file: output\.md/);
  assert.match(report, /truncated/);
}

function testTaskStopResultHandlesNotFound() {
  const report = formatTaskStopResult({
    taskId: "missing",
    status: "not_found",
    message: "Unknown subagent task_id: missing"
  });

  assert.match(report, /not_found/);
  assert.match(report, /Unknown subagent task_id/);
}

function testCompletionNotificationIncludesResultSummary() {
  const report = formatTaskCompletionNotification(
    createTask("completed", {
      output: "Final result",
      worktreePath: "D:/tmp/worktree",
      hasChanges: true
    })
  );

  assert.match(report, /Background task completed/);
  assert.match(report, /Final result/);
  assert.match(report, /Worktree changes: yes/);
}

function createTask(
  status: SubagentTaskInfo["status"],
  patch: Partial<SubagentTaskInfo> = {}
): SubagentTaskInfo {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    taskId: "task-1",
    agentType: "verify",
    description: "Run checks",
    model: "test-model",
    maxSteps: 8,
    status,
    createdAt: now,
    updatedAt: now,
    progress: [],
    ...patch
  };
}

runTests();
