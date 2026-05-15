import assert from "node:assert/strict";
import { prepareSessionResume } from "./sessionResume.js";
import type { LoadedSessionHistory } from "./types.js";

function runTests() {
  testPrepareSessionResumeKeepsLightweightTaskIndex();
  console.log("session resume tests passed");
}

function testPrepareSessionResumeKeepsLightweightTaskIndex() {
  const history: LoadedSessionHistory = {
    sessionId: "session-1",
    filePath: "/tmp/session-1.jsonl",
    workspaceRoot: "/tmp/workspace",
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:10:00.000Z",
    title: "Resume test",
    messageCount: 2,
    lastSequence: 6,
    apiMessages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" }
    ],
    uiMessages: [],
    sessionMemory: null,
    fileSnapshots: [],
    subagentTaskIndex: [
      {
        taskId: "task-1",
        agentType: "explore",
        description: "Explore",
        model: "test-model",
        maxSteps: 4,
        status: "completed",
        createdAt: "2026-05-07T00:01:00.000Z",
        updatedAt: "2026-05-07T00:02:00.000Z",
        completedAt: "2026-05-07T00:02:00.000Z"
      }
    ],
    subagentEvents: [
      {
        type: "subagent-notification",
        taskId: "task-1",
        agentType: "explore",
        description: "Explore",
        model: "test-model",
        maxSteps: 4,
        status: "completed"
      }
    ]
  };

  const payload = prepareSessionResume(history);
  assert.equal(payload.sessionId, "session-1");
  assert.equal(payload.subagentTaskIndex.length, 1);
  assert.equal(payload.subagentTaskIndex[0]?.taskId, "task-1");
  assert.equal(payload.subagentTaskIndex[0]?.status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "subagentEvents"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "filePath"), false);
}

runTests();
