import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  ConversationCompactor,
  DEFAULT_CONVERSATION_COMPACTION_CONFIG
} from "./conversationCompactor.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

async function runTests() {
  await testAutoCompactCircuitBreakerStopsAfterFailures();
  await testSuccessfulCompactResetsCircuitBreaker();
  await testTimeoutCountsAsAutoFailureEvenWhenParentSignalAborts();
  await testIgnoredTimeoutAbortDoesNotCommitLateSummary();
  console.log("conversationCompactor tests passed");
}

async function testAutoCompactCircuitBreakerStopsAfterFailures() {
  let attempts = 0;
  const compactor = new ConversationCompactor({
    ...DEFAULT_CONVERSATION_COMPACTION_CONFIG,
    maxAutoFailures: 3,
    timeoutMs: 1_000
  });
  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;
          throw new Error("summary failed");
        }
      }
    }
  } as unknown as OpenAI;

  const first = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });
  const second = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });
  const third = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });
  const fourth = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });

  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(third, false);
  assert.equal(fourth, false);
  assert.equal(attempts, 3);
}

async function testSuccessfulCompactResetsCircuitBreaker() {
  let attempts = 0;
  const compactor = new ConversationCompactor({
    ...DEFAULT_CONVERSATION_COMPACTION_CONFIG,
    maxAutoFailures: 2,
    timeoutMs: 1_000
  });
  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;
          if (attempts === 1 || attempts === 3) {
            throw new Error("summary failed");
          }

          return {
            choices: [{
              message: {
                role: "assistant",
                content: "# Current State\n\nUpdated."
              }
            }]
          };
        }
      }
    }
  } as unknown as OpenAI;

  const failed = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });
  const succeeded = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });
  const failedAgain = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });
  const succeededAgain = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });

  assert.equal(failed, false);
  assert.equal(succeeded, true);
  assert.equal(failedAgain, false);
  assert.equal(succeededAgain, true);
  assert.equal(attempts, 4);
}

async function testTimeoutCountsAsAutoFailureEvenWhenParentSignalAborts() {
  let attempts = 0;
  const controller = new AbortController();
  const compactor = new ConversationCompactor({
    ...DEFAULT_CONVERSATION_COMPACTION_CONFIG,
    maxAutoFailures: 1,
    timeoutMs: 1
  });
  const client = {
    chat: {
      completions: {
        create: async (_request: unknown, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            attempts += 1;
            options?.signal?.addEventListener(
              "abort",
              () => {
                controller.abort("user-cancel");
                reject(options.signal?.reason ?? new Error("aborted"));
              },
              { once: true }
            );
          })
      }
    }
  } as unknown as OpenAI;

  const first = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true,
    abortSignal: controller.signal
  });
  const second = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });

  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(attempts, 1);
}

async function testIgnoredTimeoutAbortDoesNotCommitLateSummary() {
  let attempts = 0;
  const compactor = new ConversationCompactor({
    ...DEFAULT_CONVERSATION_COMPACTION_CONFIG,
    maxAutoFailures: 1,
    timeoutMs: 1
  });
  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            choices: [{
              message: {
                role: "assistant",
                content: "# Current State\n\nLate summary."
              }
            }]
          };
        }
      }
    }
  } as unknown as OpenAI;
  const messages = createCompactableMessages();

  const first = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages,
    force: true
  });
  const second = await compactor.maybeCompact({
    client,
    model: "test-model",
    messages: createCompactableMessages(),
    force: true
  });

  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(attempts, 1);
  assert.equal(messages.some((message) => String(message.content).includes("Late summary.")), false);
}

function createCompactableMessages(): MessageParam[] {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "one" },
    { role: "assistant", content: "one answer" },
    { role: "user", content: "two" },
    { role: "assistant", content: "two answer" },
    { role: "user", content: "three" },
    { role: "assistant", content: "three answer" },
    { role: "user", content: "four" },
    { role: "assistant", content: "four answer" }
  ];
}

void runTests();
