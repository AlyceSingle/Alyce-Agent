import assert from "node:assert/strict";
import {
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__,
  getLspDiagnosticRegistry
} from "../../services/lsp/LspDiagnosticRegistry.js";
import { __POST_WRITE_CHECKS_TESTING__, type PostWriteDiagnosticsResult } from "./postWriteChecks.js";

async function runTests() {
  await testInlineDiagnosticsObservation();
  await testPendingDiagnosticsObservationAndFinalCompletion();
  console.log("postWriteChecks tests passed");
}

async function testInlineDiagnosticsObservation() {
  __POST_WRITE_CHECKS_TESTING__.resetPostWriteDiagnosticsObservationStats();
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__.reset();

  const result = await __POST_WRITE_CHECKS_TESTING__.resolveDiagnosticsForToolResponse({
    absolutePath: "D:\\Code\\AlyceAgent\\src\\sample.ts",
    workspaceRoot: "D:\\Code\\AlyceAgent",
    startedAtMs: Date.now(),
    inlineBudgetMs: 50,
    diagnosticsPromise: Promise.resolve(createDiagnosticsResult("ok"))
  });

  assert.equal(result.status, "ok");

  const snapshot = __POST_WRITE_CHECKS_TESTING__.getPostWriteDiagnosticsObservationStatsSnapshot();
  assert.equal(snapshot.totalRuns, 1);
  assert.equal(snapshot.inlineCompletions, 1);
  assert.equal(snapshot.pendingReturns, 0);
  assert.equal(snapshot.backgroundCompletions, 0);
  assert.equal(snapshot.returnedStatusCounts.ok, 1);
  assert.equal(snapshot.lastObservation?.filePath, "src/sample.ts");
  assert.equal(snapshot.lastObservation?.returnedStatus, "ok");
  assert.equal(snapshot.lastObservation?.returnedPending, false);
}

async function testPendingDiagnosticsObservationAndFinalCompletion() {
  __POST_WRITE_CHECKS_TESTING__.resetPostWriteDiagnosticsObservationStats();
  __LSP_DIAGNOSTIC_REGISTRY_TESTING__.reset();
  const registry = getLspDiagnosticRegistry();

  let resolveDiagnostics: (result: PostWriteDiagnosticsResult) => void = () => undefined;
  const diagnosticsPromise = new Promise<PostWriteDiagnosticsResult>((resolve) => {
    resolveDiagnostics = resolve;
  });

  const result = await __POST_WRITE_CHECKS_TESTING__.resolveDiagnosticsForToolResponse({
    absolutePath: "D:\\Code\\AlyceAgent\\src\\late.ts",
    workspaceRoot: "D:\\Code\\AlyceAgent",
    startedAtMs: Date.now(),
    inlineBudgetMs: 1,
    diagnosticsPromise
  });

  assert.equal(result.status, "pending");

  let snapshot = __POST_WRITE_CHECKS_TESTING__.getPostWriteDiagnosticsObservationStatsSnapshot();
  assert.equal(snapshot.totalRuns, 1);
  assert.equal(snapshot.inlineCompletions, 0);
  assert.equal(snapshot.pendingReturns, 1);
  assert.equal(snapshot.returnedStatusCounts.pending, 1);
  assert.equal(snapshot.lastObservation?.filePath, "src/late.ts");
  assert.equal(snapshot.lastObservation?.returnedPending, true);
  assert.equal(registry.getPendingSnapshot().length, 1);

  const completedEventPromise = new Promise<ReturnType<typeof registry.getCompletedEventsSnapshot>[number]>((resolve) => {
    const unsubscribe = registry.subscribeCompleted((event) => {
      unsubscribe();
      resolve(event);
    });
  });

  resolveDiagnostics(createDiagnosticsResult("issues", 2));
  const completedEvent = await completedEventPromise;

  snapshot = __POST_WRITE_CHECKS_TESTING__.getPostWriteDiagnosticsObservationStatsSnapshot();
  assert.equal(snapshot.backgroundCompletions, 1);
  assert.equal(snapshot.finalStatusCounts.issues, 1);
  assert.equal(snapshot.lastObservation?.finalStatus, "issues");
  assert.equal(snapshot.lastObservation?.finalIssueCount, 2);
  assert.equal(registry.getPendingSnapshot().length, 0);
  assert.equal(registry.getCompletedEventsSnapshot().length, 1);
  assert.equal(completedEvent.status, "issues");
  assert.equal(completedEvent.filePath, "src/late.ts");
  assert.equal(completedEvent.totalIssueCount, 2);
  assert.equal(completedEvent.source, "post-write");
}

function createDiagnosticsResult(
  status: PostWriteDiagnosticsResult["status"],
  totalIssueCount = 0
): PostWriteDiagnosticsResult {
  return {
    status,
    backend: "typescript-language-service",
    issues: [],
    totalIssueCount,
    truncated: false
  };
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
