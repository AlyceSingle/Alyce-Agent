import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkillContextMessage } from "../api/generatedMessages.js";
import { SessionHistoryStore } from "./sessionStorage.js";

const SESSION_ID = "rewind-compat";

async function runTests() {
  await testGeneratedContextMessagesAreNotPersisted();
  await testGeneratedContextMessagesAreIgnoredWhenLoading();
  await testRestoredInputRewindUsesOriginalCheckpoint();
  await testRewindDropsCheckpointsFromPrunedBranches();
  await testRewindCheckpointPreservesNestedMessages();
  console.log("Session history storage tests passed");
}

async function testGeneratedContextMessagesAreNotPersisted() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-history-generated-"));
  const store = new SessionHistoryStore({
    sessionsDirectory: directory,
    workspaceRoot: process.cwd(),
    sessionId: SESSION_ID
  });

  await store.recordTurn({
    apiMessages: [
      { role: "user", content: "real request" },
      createSkillContextMessage("generated skill body"),
      { role: "assistant", content: "answer" }
    ],
    uiMessages: []
  });

  const loaded = await store.loadSession(SESSION_ID);
  assert.deepEqual(loaded.apiMessages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(loaded.apiMessages.some((message) => message.role === "user" && "name" in message), false);
}

async function testGeneratedContextMessagesAreIgnoredWhenLoading() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-history-load-generated-"));
  const store = new SessionHistoryStore({
    sessionsDirectory: directory,
    workspaceRoot: process.cwd(),
    sessionId: SESSION_ID
  });

  const filePath = store.getCurrentSessionFilePath();
  const entries = [
    meta(),
    api(1, "user", "first"),
    generatedApi(2, "generated skill body"),
    api(3, "assistant", "answer")
  ];
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const loaded = await store.loadSession(SESSION_ID);
  assert.deepEqual(loaded.apiMessages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(loaded.title, "first");
}

async function testRestoredInputRewindUsesOriginalCheckpoint() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-history-"));
  const store = new SessionHistoryStore({
    sessionsDirectory: directory,
    workspaceRoot: process.cwd(),
    sessionId: SESSION_ID
  });

  const filePath = store.getCurrentSessionFilePath();
  const entries = [
    meta(),
    api(1, "user", "first"),
    api(2, "assistant", "first answer"),
    api(3, "user", "demo"),
    api(4, "assistant", "original demo"),
    api(5, "user", "leaked branch"),
    rewind(6, 0, 0),
    api(7, "system", "# Compacted Conversation Summary\n\nleaked branch"),
    api(8, "user", "other branch"),
    api(9, "assistant", "other answer"),
    rewind(10, 2, 0, "demo"),
    api(11, "user", "demo"),
    api(12, "assistant", "restored demo")
  ];
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const loaded = await store.loadSession(SESSION_ID);
  const texts = loaded.apiMessages.map((message) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  );

  assert.deepEqual(texts, [
    "first",
    "first answer",
    "demo",
    "restored demo"
  ]);
}

async function testRewindDropsCheckpointsFromPrunedBranches() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-history-pruned-"));
  const store = new SessionHistoryStore({
    sessionsDirectory: directory,
    workspaceRoot: process.cwd(),
    sessionId: SESSION_ID
  });

  const filePath = store.getCurrentSessionFilePath();
  const entries = [
    meta(),
    api(1, "user", "root"),
    api(2, "assistant", "root answer"),
    api(3, "user", "same"),
    api(4, "assistant", "pruned same answer"),
    rewind(5, 2, 0, "root"),
    api(6, "user", "same"),
    api(7, "assistant", "kept same answer"),
    rewind(8, 2, 0, "same"),
    api(9, "user", "same"),
    api(10, "assistant", "restored same answer")
  ];
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const loaded = await store.loadSession(SESSION_ID);
  const texts = loaded.apiMessages.map((message) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  );

  assert.deepEqual(texts, [
    "same",
    "restored same answer"
  ]);
}

async function testRewindCheckpointPreservesNestedMessages() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-session-history-clone-"));
  const store = new SessionHistoryStore({
    sessionsDirectory: directory,
    workspaceRoot: process.cwd(),
    sessionId: SESSION_ID
  });

  const filePath = store.getCurrentSessionFilePath();
  const entries = [
    meta(),
    {
      type: "api-message",
      sessionId: SESSION_ID,
      sequence: 1,
      timestamp: "2026-05-07T00:00:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "root"
          }
        ]
      }
    },
    api(2, "assistant", "root answer"),
    api(3, "user", "target"),
    api(4, "assistant", "pruned target"),
    rewind(5, 2, 0, "target"),
    api(6, "user", "target"),
    api(7, "assistant", "restored target")
  ];
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const loaded = await store.loadSession(SESSION_ID);
  const first = loaded.apiMessages[0] as { content?: Array<{ text?: string }> };
  assert.equal(first.content?.[0]?.text, "root");
  assert.equal(loaded.apiMessages.at(-1)?.content, "restored target");

  if (first.content?.[0]) {
    first.content[0].text = "mutated";
  }

  const loadedAgain = await store.loadSession(SESSION_ID);
  const restored = loadedAgain.apiMessages[0] as { content?: Array<{ text?: string }> };
  assert.equal(restored.content?.[0]?.text, "root");
}

function meta() {
  return {
    type: "session-meta",
    schemaVersion: 1,
    sessionId: SESSION_ID,
    workspaceRoot: process.cwd(),
    createdAt: "2026-05-07T00:00:00.000Z"
  };
}

function api(sequence: number, role: "system" | "user" | "assistant", content: string) {
  return {
    type: "api-message",
    sessionId: SESSION_ID,
    sequence,
    timestamp: "2026-05-07T00:00:00.000Z",
    message: {
      role,
      content
    }
  };
}

function generatedApi(sequence: number, content: string) {
  return {
    type: "api-message",
    sessionId: SESSION_ID,
    sequence,
    timestamp: "2026-05-07T00:00:00.000Z",
    message: createSkillContextMessage(content)
  };
}

function rewind(
  sequence: number,
  apiMessageCount: number,
  uiMessageCount: number,
  restoredInput?: string
) {
  return {
    type: "session-rewind",
    sessionId: SESSION_ID,
    sequence,
    timestamp: "2026-05-07T00:00:00.000Z",
    apiMessageCount,
    uiMessageCount,
    restoredInput,
    restoreMode: "conversation"
  };
}

void runTests();
