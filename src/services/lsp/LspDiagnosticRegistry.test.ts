import assert from "node:assert/strict";
import {
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__,
  getLspDiagnosticRegistry,
  type LspDiagnosticIssue,
  type LspDiagnosticPromiseResult
} from "./LspDiagnosticRegistry.js";

async function runTests() {
  await testPendingDiagnosticsPublishesCompletedEvent();
  await testDuplicateCompletionIdIsIgnored();
  testIssueDeduplicationAndDisplayLimit();
  await testPendingDiagnosticsTimeoutPublishesFailedEvent();
  await testCircuitBreakerBlocksNewDiagnosticsAfterRepeatedFailures();
  console.log("LspDiagnosticRegistry tests passed");
}

async function testPendingDiagnosticsPublishesCompletedEvent() {
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__.reset();
  const registry = getLspDiagnosticRegistry();

  let resolveDiagnostics: (value: {
    status: "issues";
    backend: "typescript-language-service";
    issues: [];
    totalIssueCount: 1;
    truncated: false;
    message: string;
  }) => void = () => undefined;
  const diagnosticsPromise = new Promise<{
    status: "issues";
    backend: "typescript-language-service";
    issues: [];
    totalIssueCount: 1;
    truncated: false;
    message: string;
  }>((resolve) => {
    resolveDiagnostics = resolve;
  });

  const completedEventPromise = waitForNextCompletedEvent(registry);
  const id = registry.registerPendingDiagnostics({
    source: "post-write",
    filePath: "src/app.ts",
    backend: "typescript-language-service",
    startedAtMs: Date.now(),
    diagnosticsPromise
  });

  assert.equal(registry.getPendingSnapshot().length, 1);
  assert.equal(registry.getPendingSnapshot()[0]?.id, id);

  resolveDiagnostics({
    status: "issues",
    backend: "typescript-language-service",
    issues: [],
    totalIssueCount: 1,
    truncated: false,
    message: "1 issue"
  });

  const event = await completedEventPromise;
  assert.equal(event.id, id);
  assert.equal(event.filePath, "src/app.ts");
  assert.equal(event.status, "issues");
  assert.equal(event.totalIssueCount, 1);
  assert.equal(event.completionReason, "completed");
  assert.equal(registry.getPendingSnapshot().length, 0);
}

async function testDuplicateCompletionIdIsIgnored() {
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__.reset();
  const registry = getLspDiagnosticRegistry();
  const id = "fixed-id";

  registry.publishCompletedDiagnostics({
    id,
    source: "post-write",
    filePath: "src/demo.ts",
    backend: "typescript-language-service",
    status: "ok",
    issues: [],
    totalIssueCount: 0,
    truncated: false
  });
  registry.publishCompletedDiagnostics({
    id,
    source: "post-write",
    filePath: "src/demo.ts",
    backend: "typescript-language-service",
    status: "failed",
    issues: [],
    totalIssueCount: 0,
    truncated: false,
    message: "should be ignored"
  });

  const completed = registry.getCompletedEventsSnapshot();
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.status, "ok");
}

function testIssueDeduplicationAndDisplayLimit() {
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__.reset({
    maxIssuesPerEvent: 2
  });
  const registry = getLspDiagnosticRegistry();
  const issues: LspDiagnosticIssue[] = [
    createIssue("src/a.ts", 1, 1, "duplicate-one"),
    createIssue("src/a.ts", 1, 1, "duplicate-one"),
    createIssue("src/a.ts", 2, 1, "unique-two"),
    createIssue("src/b.ts", 3, 1, "unique-three")
  ];

  registry.publishCompletedDiagnostics({
    source: "post-write",
    filePath: "src/a.ts",
    backend: "typescript-language-service",
    status: "issues",
    issues,
    totalIssueCount: issues.length,
    truncated: false
  });

  const event = registry.getCompletedEventsSnapshot()[0];
  assert.ok(event);
  assert.equal(event.issues.length, 2);
  assert.equal(event.originalIssueCount, 4);
  assert.equal(event.duplicateIssueCount, 1);
  assert.equal(event.omittedIssueCount, 1);
  assert.equal(event.groupedFileCount, 2);
  assert.equal(event.truncated, true);
}

async function testPendingDiagnosticsTimeoutPublishesFailedEvent() {
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__.reset({
    pendingTimeoutMs: 25
  });
  const registry = getLspDiagnosticRegistry();
  const completedEventPromise = waitForNextCompletedEvent(registry, 1_500);
  const unresolved = new Promise<LspDiagnosticPromiseResult>(() => undefined);

  registry.registerPendingDiagnostics({
    source: "post-write",
    filePath: "src/timeout.ts",
    backend: "typescript-language-service",
    startedAtMs: Date.now(),
    diagnosticsPromise: unresolved
  });

  const event = await completedEventPromise;
  assert.equal(event.status, "failed");
  assert.equal(event.completionReason, "timeout");
  assert.match(event.message ?? "", /timed out/i);
  assert.equal(registry.getPendingSnapshot().length, 0);
}

async function testCircuitBreakerBlocksNewDiagnosticsAfterRepeatedFailures() {
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__.reset({
    circuitBreakerFailureThreshold: 2,
    circuitBreakerCooldownMs: 5_000
  });
  const registry = getLspDiagnosticRegistry();

  registry.publishCompletedDiagnostics({
    source: "post-write",
    filePath: "src/failure-1.ts",
    backend: "typescript-language-service",
    status: "failed",
    issues: [],
    totalIssueCount: 0,
    truncated: false,
    message: "first failure"
  });
  registry.publishCompletedDiagnostics({
    source: "post-write",
    filePath: "src/failure-2.ts",
    backend: "typescript-language-service",
    status: "failed",
    issues: [],
    totalIssueCount: 0,
    truncated: false,
    message: "second failure"
  });

  const blockedEventPromise = waitForNextCompletedEvent(registry);
  registry.registerPendingDiagnostics({
    source: "post-write",
    filePath: "src/blocked.ts",
    backend: "typescript-language-service",
    startedAtMs: Date.now(),
    diagnosticsPromise: Promise.resolve({
      status: "ok",
      backend: "typescript-language-service",
      issues: [],
      totalIssueCount: 0,
      truncated: false
    })
  });

  const blocked = await blockedEventPromise;
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.completionReason, "circuit-breaker");
  assert.equal(blocked.circuitBreakerOpen, true);
  assert.ok(blocked.circuitBreakerOpenUntil);
  assert.equal(registry.getPendingSnapshot().length, 0);

  const snapshot = registry.getCircuitBreakerSnapshot();
  const backendSnapshot = snapshot.find((entry) => entry.backend === "typescript-language-service");
  assert.equal(backendSnapshot?.open, true);
}

function createIssue(filePath: string, line: number, character: number, message: string): LspDiagnosticIssue {
  return {
    filePath,
    line,
    character,
    severity: "error",
    code: "TS1000",
    source: "ts",
    message
  };
}

function waitForNextCompletedEvent(
  registry: ReturnType<typeof getLspDiagnosticRegistry>,
  timeoutMs = 1_000
) {
  return new Promise<ReturnType<typeof registry.getCompletedEventsSnapshot>[number]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for diagnostics completed event after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = registry.subscribeCompleted((event) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
