import assert from "node:assert/strict";
import type { LspDiagnosticCompletedEvent } from "../../services/lsp/LspDiagnosticRegistry.js";
import type { TerminalUiMessage } from "../state/types.js";
import {
  createToolResultMessage,
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
  testProcessStartRunningResultUsesReadableBlocks();
  testPtyReadResultUsesReadableBlocks();
  testPtyListResultUsesReadableBlocks();
  testApplyPatchResultSynthesizesStructuredPatchHunkHeader();
  testWriteResultKeepsStructuredPatchHunkHeaderAndFiltersFileMetadata();
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

function testProcessStartRunningResultUsesReadableBlocks() {
  const message = createToolResultMessage(
    "ProcessStart",
    JSON.stringify({
      ok: true,
      status: "success",
      tool: "ProcessStart",
      result: {
        status: "running",
        process_id: "bg_test",
        pid: 12345,
        command: "npm run dev",
        cwd: "C:\\workspace",
        started_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:01.000Z",
        stdout_log_path: "C:\\workspace\\.alyce\\background-processes\\bg_test\\stdout.log",
        stderr_log_path: "C:\\workspace\\.alyce\\background-processes\\bg_test\\stderr.log",
        combined_log_path: "C:\\workspace\\.alyce\\background-processes\\bg_test\\output.log",
        record_path: "C:\\workspace\\.alyce\\background-processes\\bg_test\\process.json",
        stdout_preview: "Local: http://localhost:5173/",
        stderr_preview: "",
        detected_urls: ["http://localhost:5173/"],
        detected_ports: [5173],
        startup_matched: "Local:"
      }
    }),
    JSON.stringify({ command: "npm run dev" })
  );

  assert.equal(message.kind, "tool");
  assert.equal(message.blocks[0]?.label, "Process");
  assert.equal(message.blocks[0]?.tone, "success");
  assert.match(message.blocks[0]?.content ?? "", /Status: running/);
  assert.match(message.blocks[0]?.content ?? "", /Process: bg_test/);
  assert.match(message.blocks[0]?.content ?? "", /URL: http:\/\/localhost:5173\//);
  assert.match(message.blocks[0]?.content ?? "", /Log: .*output\.log/);
  assert.equal(message.blocks[1]?.label, "Command");
  assert.equal(message.blocks[1]?.content, "$ npm run dev");
}

function testPtyReadResultUsesReadableBlocks() {
  const message = createToolResultMessage(
    "PtyRead",
    JSON.stringify({
      ok: true,
      status: "success",
      tool: "PtyRead",
      result: {
        pty_id: "pty_test",
        content: "ready\r\nprompt> ",
        cursor: 0,
        next_cursor: 15,
        buffer_cursor: 0,
        bytes: 15,
        eof: true,
        session: {
          pty_id: "pty_test",
          title: "node repl",
          command: "node",
          args: [],
          cwd: "C:\\workspace",
          status: "running",
          pid: 12345,
          cols: 80,
          rows: 24,
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:01.000Z"
        }
      }
    }),
    JSON.stringify({ pty_id: "pty_test" })
  );

  assert.equal(message.kind, "tool");
  assert.equal(message.title, "PtyRead pty_test");
  assert.equal(message.blocks[0]?.label, "PTY Output");
  assert.equal(message.blocks[0]?.tone, "success");
  assert.match(message.blocks[0]?.content ?? "", /ready/);
  assert.equal(message.blocks[1]?.label, "Details");
  assert.match(message.blocks[1]?.content ?? "", /Next cursor: 15/);
  assert.match(message.blocks[1]?.content ?? "", /Status: running/);
}

function testPtyListResultUsesReadableBlocks() {
  const message = createToolResultMessage(
    "PtyList",
    JSON.stringify({
      ok: true,
      status: "success",
      tool: "PtyList",
      result: {
        sessions: [
          {
            pty_id: "pty_test",
            title: "shell",
            command: "pwsh.exe",
            args: [],
            cwd: "C:\\workspace",
            status: "running",
            pid: 12345,
            cols: 100,
            rows: 30,
            created_at: "2026-05-10T00:00:00.000Z",
            updated_at: "2026-05-10T00:00:01.000Z"
          }
        ]
      }
    }),
    JSON.stringify({})
  );

  assert.equal(message.blocks[0]?.label, "PTY Sessions");
  assert.equal(message.blocks[0]?.tone, "success");
  assert.match(message.blocks[0]?.content ?? "", /pty_test/);
  assert.match(message.blocks[0]?.content ?? "", /pwsh\.exe/);
}

function testApplyPatchResultSynthesizesStructuredPatchHunkHeader() {
  const message = createToolResultMessage(
    "apply_patch",
    JSON.stringify({
      ok: true,
      status: "success",
      tool: "apply_patch",
      result: {
        filePath: "src/demo.ts",
        operationCount: 1,
        additions: 1,
        deletions: 1,
        files: [
          {
            type: "update",
            filePath: "src/demo.ts",
            additions: 1,
            deletions: 1,
            matchStrategies: []
          }
        ],
        structuredPatch: [
          {
            oldStart: 42,
            oldLines: 1,
            newStart: 42,
            newLines: 1,
            lines: ["@@", "-old line", "+new line"]
          }
        ],
        formatter: { status: "skipped" },
        diagnostics: {
          status: "skipped",
          issues: [],
          totalIssueCount: 0,
          truncated: false
        }
      }
    }),
    JSON.stringify({ patchText: "patch" })
  );

  const patchBlock = message.blocks.find((block) => block.label === "Patch");
  assert.equal(patchBlock?.content, "@@ -42,1 +42,1 @@\n-old line\n+new line");
}

function testWriteResultKeepsStructuredPatchHunkHeaderAndFiltersFileMetadata() {
  const message = createToolResultMessage(
    "Write",
    JSON.stringify({
      ok: true,
      status: "success",
      tool: "Write",
      result: {
        filePath: "src/demo.ts",
        type: "update",
        bytes: 18,
        lineCount: 2,
        structuredPatch: [
          {
            oldStart: 10,
            oldLines: 1,
            newStart: 10,
            newLines: 2,
            lines: [
              "--- src/demo.ts",
              "+++ src/demo.ts",
              "@@ -10,1 +10,2 @@",
              "-old line",
              "+new line",
              "+another line"
            ]
          }
        ],
        formatter: { status: "skipped" },
        diagnostics: {
          status: "skipped",
          issues: [],
          totalIssueCount: 0,
          truncated: false
        }
      }
    }),
    JSON.stringify({ file_path: "src/demo.ts" })
  );

  const patchBlock = message.blocks.find((block) => block.label === "Patch");
  assert.equal(
    patchBlock?.content,
    "@@ -10,1 +10,2 @@\n-old line\n+new line\n+another line"
  );
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
