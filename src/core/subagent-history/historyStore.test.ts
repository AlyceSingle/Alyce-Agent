import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentHistoryStore } from "./historyStore.js";
import {
  SUBAGENT_METADATA_VERSION,
  type SubagentMetadataV1,
  type SubagentTranscriptEntry
} from "./types.js";

async function runTests() {
  await testMetadataWrite();
  await testMetadataReadMissingReturnsUndefined();
  await testTranscriptAppendOrder();
  await testWriteQueueIsReleasedAfterWrite();
  await testTranscriptRequiredReadThrowsWhenMissing();
  await testTranscriptReadSkipsBrokenLines();
  await testCorruptedTranscriptDoesNotAffectOtherAgents();
  await testOutputWrite();
  console.log("subagent history store tests passed");
}

async function testMetadataWrite() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-meta-"));
  try {
    const store = new SubagentHistoryStore();
    const metadataPath = path.join(root, "sessions", "s1", "subagents", "a1.meta.json");
    const metadata: SubagentMetadataV1 = {
      version: SUBAGENT_METADATA_VERSION,
      agentId: "a1",
      parentSessionId: "s1",
      agentType: "explore",
      description: "inspect",
      model: "gpt-test",
      maxSteps: 5,
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    await store.writeMetadata(metadataPath, metadata);

    const raw = await readFile(metadataPath, "utf8");
    assert.deepEqual(JSON.parse(raw), metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testTranscriptAppendOrder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-transcript-"));
  try {
    const store = new SubagentHistoryStore();
    const transcriptPath = path.join(root, "sessions", "s1", "subagents", "a1.jsonl");
    const first: SubagentTranscriptEntry[] = [
      {
        type: "status",
        timestamp: "2026-01-01T00:00:00.000Z",
        agentId: "a1",
        parentSessionId: "s1",
        status: "running",
        message: "started"
      }
    ];
    const second: SubagentTranscriptEntry[] = [
      {
        type: "tool-event",
        timestamp: "2026-01-01T00:00:01.000Z",
        agentId: "a1",
        parentSessionId: "s1",
        event: {
          phase: "result",
          toolName: "TaskList",
          result: "ok"
        }
      }
    ];

    await Promise.all([
      store.appendTranscriptEntries(transcriptPath, first),
      store.appendTranscriptEntries(transcriptPath, second)
    ]);

    const lines = (await readFile(transcriptPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(lines.length, 2);
    const parsed = lines.map((line) => JSON.parse(line) as SubagentTranscriptEntry);
    assert.equal(parsed[0]?.type, "status");
    assert.equal(parsed[1]?.type, "tool-event");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testWriteQueueIsReleasedAfterWrite() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-queue-release-"));
  try {
    const store = new SubagentHistoryStore();
    const transcriptPath = path.join(root, "sessions", "s1", "subagents", "a1.jsonl");
    await store.appendTranscriptEntries(transcriptPath, [
      {
        type: "status",
        timestamp: "2026-01-01T00:00:00.000Z",
        agentId: "a1",
        parentSessionId: "s1",
        status: "running"
      }
    ]);

    const writeQueues = (store as unknown as { writeQueues?: Map<string, Promise<void>> }).writeQueues;
    assert.equal(writeQueues?.size ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testMetadataReadMissingReturnsUndefined() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-meta-missing-"));
  try {
    const store = new SubagentHistoryStore();
    const metadataPath = path.join(root, "sessions", "s1", "subagents", "missing.meta.json");
    const metadata = await store.readMetadata(metadataPath);
    assert.equal(metadata, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testTranscriptRequiredReadThrowsWhenMissing() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-transcript-required-"));
  try {
    const store = new SubagentHistoryStore();
    const transcriptPath = path.join(root, "sessions", "s1", "subagents", "missing.jsonl");
    await assert.rejects(
      () => store.readTranscriptEntriesRequired(transcriptPath),
      /Subagent transcript not found/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testTranscriptReadSkipsBrokenLines() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-transcript-broken-"));
  try {
    const store = new SubagentHistoryStore();
    const transcriptPath = path.join(root, "sessions", "s1", "subagents", "a1.jsonl");
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(
      transcriptPath,
      [
        "{\"type\":\"status\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"agentId\":\"a1\",\"parentSessionId\":\"s1\",\"status\":\"running\"}",
        "{broken-json-line}",
        "{\"type\":\"status\",\"timestamp\":\"2026-01-01T00:00:01.000Z\",\"agentId\":\"a1\",\"parentSessionId\":\"s1\",\"status\":\"completed\"}",
        ""
      ].join("\n"),
      "utf8"
    );

    const parsed = await store.readTranscriptEntries(transcriptPath);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.type, "status");
    assert.equal(parsed[1]?.type, "status");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCorruptedTranscriptDoesNotAffectOtherAgents() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-transcript-isolation-"));
  try {
    const store = new SubagentHistoryStore();
    const brokenTranscriptPath = path.join(root, "sessions", "s1", "subagents", "a-broken.jsonl");
    const healthyTranscriptPath = path.join(root, "sessions", "s1", "subagents", "a-healthy.jsonl");
    await mkdir(path.dirname(brokenTranscriptPath), { recursive: true });
    await writeFile(
      brokenTranscriptPath,
      [
        "{\"type\":\"status\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"agentId\":\"a-broken\",\"parentSessionId\":\"s1\",\"status\":\"running\"}",
        "{broken-json-line}",
        "{\"type\":\"status\",\"timestamp\":\"2026-01-01T00:00:01.000Z\",\"agentId\":\"a-broken\",\"parentSessionId\":\"s1\",\"status\":\"failed\"}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      healthyTranscriptPath,
      [
        "{\"type\":\"status\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"agentId\":\"a-healthy\",\"parentSessionId\":\"s1\",\"status\":\"running\"}",
        "{\"type\":\"status\",\"timestamp\":\"2026-01-01T00:00:02.000Z\",\"agentId\":\"a-healthy\",\"parentSessionId\":\"s1\",\"status\":\"completed\"}",
        ""
      ].join("\n"),
      "utf8"
    );

    const brokenEntries = await store.readTranscriptEntries(brokenTranscriptPath);
    const healthyEntries = await store.readTranscriptEntries(healthyTranscriptPath);
    assert.equal(brokenEntries.length, 2);
    assert.equal(healthyEntries.length, 2);
    assert.equal(healthyEntries[1]?.type, "status");
    assert.equal(healthyEntries[1]?.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testOutputWrite() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-subagent-history-output-"));
  try {
    const store = new SubagentHistoryStore();
    const outputPath = path.join(root, "sessions", "s1", "tasks", "a1.output");
    await store.writeOutput(outputPath, "hello");
    const raw = await readFile(outputPath, "utf8");
    assert.equal(raw, "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void runTests();
