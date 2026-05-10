import assert from "node:assert/strict";
import type { LspDiagnosticCompletedEvent } from "../../services/lsp/LspDiagnosticRegistry.js";
import type { TerminalUiMessage } from "../state/types.js";
import {
  createDiagnosticsFollowUpMessage,
  formatDiagnosticsFollowUpForModel,
  isEphemeralProgressMessage
} from "./messageMapper.js";

function createMessage(overrides: Partial<TerminalUiMessage>): TerminalUiMessage {
  return {
    id: "message-id",
    kind: "system",
    title: "System",
    blocks: [],
    content: "",
    preview: "",
    metadata: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

function runTests() {
  testDetectsProgressTitle();
  testDetectsProgressMetadataToken();
  testDetectsProgressMetadataPrefix();
  testIgnoresNonProgressMetadataText();
  testDiagnosticsFollowUpIncludesPhase5Metadata();
  console.log("messageMapper tests passed");
}

function testDetectsProgressTitle() {
  const message = createMessage({ kind: "system", title: "Progress" });
  assert.equal(isEphemeralProgressMessage(message), true);
}

function testDetectsProgressMetadataToken() {
  const message = createMessage({ metadata: ["progress"] });
  assert.equal(isEphemeralProgressMessage(message), true);
}

function testDetectsProgressMetadataPrefix() {
  const message = createMessage({ metadata: ["progress: 3/10"] });
  assert.equal(isEphemeralProgressMessage(message), true);
}

function testIgnoresNonProgressMetadataText() {
  const message = createMessage({ metadata: ["tool result", "in progress"] });
  assert.equal(isEphemeralProgressMessage(message), false);
}

function testDiagnosticsFollowUpIncludesPhase5Metadata() {
  const event: LspDiagnosticCompletedEvent = {
    id: "diag-1",
    source: "post-write",
    filePath: "src/demo.ts",
    backend: "typescript-language-service",
    status: "issues",
    issues: [
      {
        filePath: "src/demo.ts",
        line: 5,
        character: 1,
        severity: "error",
        code: "TS1005",
        source: "ts",
        message: "Missing token"
      }
    ],
    totalIssueCount: 6,
    truncated: true,
    message: "Issues detected",
    startedAt: "2026-05-10T00:00:00.000Z",
    completedAt: "2026-05-10T00:00:01.000Z",
    durationMs: 1_000,
    completionReason: "timeout",
    originalIssueCount: 8,
    duplicateIssueCount: 2,
    omittedIssueCount: 3,
    groupedFileCount: 2,
    failureStreak: 2,
    circuitBreakerOpen: true,
    circuitBreakerOpenUntil: "2026-05-10T00:05:00.000Z"
  };

  const uiMessage = createDiagnosticsFollowUpMessage(event);
  assert.equal(uiMessage.metadata.includes("Reason: timeout"), true);
  assert.equal(uiMessage.metadata.includes("Deduped: 2"), true);
  assert.equal(uiMessage.metadata.includes("Omitted: 3"), true);
  assert.equal(uiMessage.metadata.includes("Files: 2"), true);
  assert.equal(
    uiMessage.metadata.includes("Circuit: open until 2026-05-10T00:05:00.000Z"),
    true
  );

  const modelMessage = formatDiagnosticsFollowUpForModel(event);
  assert.equal(modelMessage.includes("Completion: timeout"), true);
  assert.equal(modelMessage.includes("Deduped duplicates: 2"), true);
  assert.equal(modelMessage.includes("Omitted after cap: 3"), true);
  assert.equal(modelMessage.includes("Circuit breaker: open until 2026-05-10T00:05:00.000Z"), true);
}

runTests();
