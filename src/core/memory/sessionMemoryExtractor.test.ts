import assert from "node:assert/strict";
import type OpenAI from "openai";
import { SessionMemoryExtractor } from "./sessionMemoryExtractor.js";

async function runTests() {
  await testExtractorWritesMarkdownFromModel();
  await testExtractorUnwrapsFencedMarkdown();
  await testExtractorSkipsStaleCommit();
  await testExtractorCircuitBreaksAfterFailures();
  await testExtractorTimeoutCountsAsFailure();
  await testIgnoredTimeoutAbortStillFails();
  await testParentAbortDoesNotCountAsFailure();
  await testIgnoredParentAbortStillAborts();
  await testRestoreSnapshotRestoresCircuitBreakerState();
  console.log("sessionMemoryExtractor tests passed");
}

async function testExtractorWritesMarkdownFromModel() {
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 2
  });
  const client = createClient(async () => ({
    choices: [{
      message: {
        role: "assistant",
        content: "# Session Memory\n\n## Current State\n\nUpdated."
      }
    }]
  }));

  const promise = extractor.schedule({
    client,
    model: "test-model",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "implement phase five" }
    ],
    currentMemory: "# Session Memory\n\n## Current State",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md"
  });

  assert.ok(promise);
  const result = await promise;
  assert.equal(result.status, "updated");
  assert.match(result.markdown ?? "", /Updated\./);
}

async function testExtractorUnwrapsFencedMarkdown() {
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 2
  });
  const client = createClient(async () => ({
    choices: [{
      message: {
        role: "assistant",
        content: "```markdown\n# Session Memory\n\nReady.\n```\n"
      }
    }]
  }));

  const promise = extractor.schedule({
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md"
  });

  assert.ok(promise);
  const result = await promise;
  assert.equal(result.status, "updated");
  assert.equal(result.markdown, "# Session Memory\n\nReady.");
}

async function testExtractorSkipsStaleCommit() {
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 2
  });
  const client = createClient(async () => ({
    choices: [{
      message: {
        role: "assistant",
        content: "# Session Memory\n\nChanged."
      }
    }]
  }));

  const promise = extractor.schedule({
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md",
    shouldCommit: () => false
  });

  assert.ok(promise);
  const result = await promise;
  assert.equal(result.status, "skipped");
}

async function testExtractorCircuitBreaksAfterFailures() {
  let attempts = 0;
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 2
  });
  const client = createClient(async () => {
    attempts += 1;
    throw new Error("model failed");
  });
  const options = {
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md"
  };

  const first = extractor.schedule(options);
  assert.ok(first);
  assert.equal((await first).status, "failed");

  const second = extractor.schedule(options);
  assert.ok(second);
  assert.equal((await second).status, "failed");

  const third = extractor.schedule(options);
  assert.equal(third, null);
  assert.equal(attempts, 2);
  assert.equal(extractor.createSnapshot().disabledForSession, true);
}

async function testRestoreSnapshotRestoresCircuitBreakerState() {
  let attempts = 0;
  const source = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 1
  });
  const client = createClient(async () => {
    attempts += 1;
    throw new Error("model failed");
  });
  const options = {
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md"
  };

  const failed = source.schedule(options);
  assert.ok(failed);
  assert.equal((await failed).status, "failed");

  const restored = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 1
  });
  restored.restoreSnapshot(source.createSnapshot());

  assert.equal(restored.schedule(options), null);
  assert.equal(restored.createSnapshot().disabledForSession, true);
  assert.equal(attempts, 1);
}

async function testExtractorTimeoutCountsAsFailure() {
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1,
    maxFailures: 1
  });
  const client = createClient(async (_request, options?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason ?? new Error("aborted")),
        { once: true }
      );
    })
  );

  const promise = extractor.schedule({
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md"
  });

  assert.ok(promise);
  assert.equal((await promise).status, "failed");
  assert.equal(extractor.createSnapshot().disabledForSession, true);
}

async function testParentAbortDoesNotCountAsFailure() {
  const controller = new AbortController();
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 1
  });
  const client = createClient(async (_request, options?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason ?? new Error("aborted")),
        { once: true }
      );
      controller.abort(new Error("user cancelled"));
    })
  );

  const promise = extractor.schedule({
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md",
    abortSignal: controller.signal
  });

  assert.ok(promise);
  assert.equal((await promise).status, "aborted");
  assert.equal(extractor.createSnapshot().disabledForSession, false);
}

async function testIgnoredTimeoutAbortStillFails() {
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1,
    maxFailures: 1
  });
  const client = createClient(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      choices: [{
        message: {
          role: "assistant",
          content: "# Session Memory\n\nLate success."
        }
      }]
    };
  });

  const promise = extractor.schedule({
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md"
  });

  assert.ok(promise);
  assert.equal((await promise).status, "failed");
  assert.equal(extractor.createSnapshot().disabledForSession, true);
}

async function testIgnoredParentAbortStillAborts() {
  const controller = new AbortController();
  const extractor = new SessionMemoryExtractor({
    timeoutMs: 1_000,
    maxFailures: 1
  });
  const client = createClient(async () => {
    controller.abort(new Error("user cancelled"));
    return {
      choices: [{
        message: {
          role: "assistant",
          content: "# Session Memory\n\nLate success."
        }
      }]
    };
  });

  const promise = extractor.schedule({
    client,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    currentMemory: "# Session Memory",
    memoryPath: ".alyce/memory/SESSION_MEMORY.md",
    abortSignal: controller.signal
  });

  assert.ok(promise);
  assert.equal((await promise).status, "aborted");
  assert.equal(extractor.createSnapshot().disabledForSession, false);
}

function createClient(
  create: (request: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
): OpenAI {
  return {
    chat: {
      completions: {
        create
      }
    }
  } as unknown as OpenAI;
}

void runTests();
