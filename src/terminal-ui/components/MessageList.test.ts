import assert from "node:assert/strict";
import { __MESSAGE_LIST_TESTING__ } from "./MessageList.js";
import type { TerminalUiMessage, TerminalUiMessageBlock } from "../state/types.js";
import { createRenderPolicy } from "../utils/renderPolicy.js";

type TestMessageEntry = {
  sections: Array<{
    lines: Array<{ content: string }>;
  }>;
  markdownPlan?: {
    rowCount: number;
  };
  metadataLine?: string;
};

const testing = __MESSAGE_LIST_TESTING__ as {
  renderBlockLines: (block: TerminalUiMessageBlock, width: number) => Array<{ content: string; diffKind?: string }>;
  buildCollapsedMessageBlocks: (
    blocks: TerminalUiMessageBlock[],
    width: number,
    maxLines: number
  ) => { blocks: TerminalUiMessageBlock[]; truncated: boolean };
  combineShellOutput: (stdout: string, stderr: string) => { label: string; text: string; tone?: string } | null;
  buildRenderedMessageEntries: (
    messages: TerminalUiMessage[],
    selectedMessageId: string | null,
    contentWidth: number,
    renderPolicy: ReturnType<typeof createRenderPolicy>,
    expandedMessageIds: ReadonlySet<string>,
    assistantLabel: string,
    unseenDividerMessageId: string | null,
    liveMarkdownMessageId: string | null
  ) => TestMessageEntry[];
};

function createMessage(overrides: Partial<TerminalUiMessage>): TerminalUiMessage {
  return {
    id: "message-id",
    kind: "assistant",
    title: "Message",
    blocks: [],
    content: "",
    preview: "",
    metadata: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

function runTests() {
  const renderPolicy = createRenderPolicy({
    markdownMessageRenderingEnabled: true,
    markdownToolMessageRenderingEnabled: true,
    markdownRenderMaxChars: 32_000
  });
  testRenderBlockLinesDecodesDeepEscapedEntities();
  testRenderBlockLinesForPatchSkipsDiffMetaAndHunkHeaders();
  testBuildCollapsedMessageBlocksTruncatesWithEllipsis();
  testCombineShellOutputVariants();
  testEditLikeToolMessagesDefaultToExpandedAndCanCollapse(renderPolicy);
  testMarkdownFriendlyToolUsesMarkdownWhenExpanded(renderPolicy);
  testMarkdownFriendlyToolStillUsesMarkdownWhenMessageContentOverBudget();
  testShellToolStaysCodeFirst(renderPolicy);
  testOverBudgetMarkdownFallsBackToSections();
  testMarkdownBudgetErrorFallsBackToSections();
  console.log("MessageList tests passed");
}

function testRenderBlockLinesDecodesDeepEscapedEntities() {
  const lines = testing.renderBlockLines(
    {
      content: "* &amp;amp;quot;Hello&amp;amp;quot; *",
      style: "plain"
    },
    120
  );
  const rendered = lines.map((line) => line.content).join("\n");

  assert.match(rendered, /"Hello"/);
  assert.doesNotMatch(rendered, /&amp;quot;/);
  assert.doesNotMatch(rendered, /&quot;/);
}

function testRenderBlockLinesForPatchSkipsDiffMetaAndHunkHeaders() {
  const lines = testing.renderBlockLines(
    {
      label: "Patch",
      style: "code",
      content: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old line\n+new line\n context line"
    },
    120
  );

  assert.deepEqual(
    lines.map((line) => [line.content, line.diffKind ?? "none"]),
    [
      ["-old line", "remove"],
      ["+new line", "add"],
      [" context line", "context"]
    ]
  );
}

function testBuildCollapsedMessageBlocksTruncatesWithEllipsis() {
  const preview = testing.buildCollapsedMessageBlocks(
    [
      {
        content: "line-1\nline-2\nline-3"
      }
    ],
    80,
    2
  );

  assert.equal(preview.truncated, true);
  assert.equal(preview.blocks.length, 1);
  assert.equal(preview.blocks[0]?.content, "line-1\n...");
}

function testCombineShellOutputVariants() {
  assert.deepEqual(testing.combineShellOutput("ok\n", "warn\n"), {
    label: "Output",
    text: "ok\n\n[stderr]\nwarn",
    tone: "warning"
  });
  assert.deepEqual(testing.combineShellOutput("ok\n", ""), {
    label: "Stdout",
    text: "ok",
    tone: "success"
  });
  assert.deepEqual(testing.combineShellOutput("", "warn\n"), {
    label: "Stderr",
    text: "warn",
    tone: "warning"
  });
  assert.equal(testing.combineShellOutput("", ""), null);
}

function testEditLikeToolMessagesDefaultToExpandedAndCanCollapse(
  renderPolicy: ReturnType<typeof createRenderPolicy>
) {
  const message = createMessage({
    id: "tool-write-1",
    kind: "tool",
    title: "Write src/demo.ts",
    content: "Patch\n" + Array.from({ length: 20 }, (_, index) => `+line-${index + 1}`).join("\n"),
    metadata: ["Tool result"],
    blocks: [
      {
        label: "Patch",
        style: "code",
        content: Array.from({ length: 20 }, (_, index) => `+line-${index + 1}`).join("\n")
      }
    ],
    toolData: {
      phase: "result",
      toolName: "Write",
      summary: "Write src/demo.ts",
      ok: true,
      resultKind: "write",
      write: {
        filePath: "src/demo.ts",
        mode: "update",
        bytes: 120,
        lineCount: 20
      }
    }
  });

  const expandedEntry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    renderPolicy,
    new Set<string>(),
    "ALYCE",
    null,
    null
  )[0];
  const collapsedEntry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    renderPolicy,
    new Set<string>([message.id]),
    "ALYCE",
    null,
    null
  )[0];

  assert.ok(expandedEntry);
  assert.ok(collapsedEntry);
  assert.match(expandedEntry?.metadataLine ?? "", /Click to collapse/);
  assert.match(collapsedEntry?.metadataLine ?? "", /Click to expand/);

  const expandedLines = flattenSections(expandedEntry!);
  const collapsedLines = flattenSections(collapsedEntry!);
  assert.ok(expandedLines.length > collapsedLines.length);
  assert.deepEqual(collapsedLines, expandedLines.slice(0, collapsedLines.length));
}

function testMarkdownFriendlyToolUsesMarkdownWhenExpanded(
  renderPolicy: ReturnType<typeof createRenderPolicy>
) {
  const message = createMessage({
    id: "tool-webfetch-1",
    kind: "tool",
    title: "WebFetch https://example.com",
    content: "Output\n# Heading\n- one\n- two\n- three\n- four",
    metadata: ["Tool result"],
    blocks: [
      {
        label: "Output",
        content: "# Heading\n- one\n- two\n- three\n- four",
        tone: "success",
        style: "plain"
      }
    ],
    toolData: {
      phase: "result",
      toolName: "WebFetch",
      summary: "WebFetch https://example.com",
      ok: true,
      resultKind: "generic"
    }
  });

  const collapsedEntry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    renderPolicy,
    new Set<string>(),
    "ALYCE",
    null,
    null
  )[0];
  const expandedEntry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    renderPolicy,
    new Set<string>([message.id]),
    "ALYCE",
    null,
    null
  )[0];

  assert.ok(collapsedEntry);
  assert.ok(expandedEntry);
  assert.equal(collapsedEntry?.markdownPlan, undefined);
  assert.match(collapsedEntry?.metadataLine ?? "", /Click to expand/);
  assert.ok(expandedEntry?.markdownPlan);
  assert.equal(expandedEntry?.sections.length ?? 0, 0);
}

function testMarkdownFriendlyToolStillUsesMarkdownWhenMessageContentOverBudget() {
  const tightBudgetPolicy = createRenderPolicy({
    markdownMessageRenderingEnabled: true,
    markdownToolMessageRenderingEnabled: true,
    markdownRenderMaxChars: 80
  });
  const message = createMessage({
    id: "tool-webfetch-over-budget-content",
    kind: "tool",
    title: "WebFetch https://example.com",
    content: "summary " + "x".repeat(300),
    metadata: ["Tool result"],
    blocks: [
      {
        label: "Output",
        content: "# Heading\n- one\n- two",
        style: "plain"
      }
    ],
    toolData: {
      phase: "result",
      toolName: "WebFetch",
      summary: "WebFetch https://example.com",
      ok: true,
      resultKind: "generic"
    }
  });

  const entry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    tightBudgetPolicy,
    new Set<string>([message.id]),
    "ALYCE",
    null,
    null
  )[0];

  assert.ok(entry);
  assert.ok(entry?.markdownPlan);
  assert.equal(entry?.sections.length ?? 0, 0);
}

function testShellToolStaysCodeFirst(
  renderPolicy: ReturnType<typeof createRenderPolicy>
) {
  const message = createMessage({
    id: "tool-shell-1",
    kind: "tool",
    title: "Bash",
    content: "Command\n$ echo hi\n\nStdout\nhi",
    metadata: ["Tool result"],
    blocks: [
      {
        label: "Command",
        content: "$ echo hi",
        style: "code"
      },
      {
        label: "Stdout",
        content: "hi",
        style: "code"
      }
    ],
    toolData: {
      phase: "result",
      toolName: "Bash",
      summary: "Bash echo hi",
      ok: true,
      resultKind: "shell",
      shell: {
        command: "echo hi",
        cwd: ".",
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "hi\n",
        stderr: "",
        durationMs: 5
      }
    }
  });

  const entry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    renderPolicy,
    new Set<string>([message.id]),
    "ALYCE",
    null,
    null
  )[0];

  assert.ok(entry);
  assert.equal(entry?.markdownPlan, undefined);
  assert.ok((entry?.sections.length ?? 0) > 0);
}

function testOverBudgetMarkdownFallsBackToSections() {
  const overBudgetPolicy = createRenderPolicy({
    markdownMessageRenderingEnabled: true,
    markdownToolMessageRenderingEnabled: true,
    markdownRenderMaxChars: 8
  });
  const message = createMessage({
    id: "assistant-over-budget",
    kind: "assistant",
    content: "# heading\n- this line is over budget",
    blocks: [
      {
        content: "# heading\n- this line is over budget"
      }
    ]
  });
  const entry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    overBudgetPolicy,
    new Set<string>(),
    "ALYCE",
    null,
    null
  )[0];

  assert.ok(entry);
  assert.equal(entry?.markdownPlan, undefined);
  assert.ok((entry?.sections.length ?? 0) > 0);
}

function testMarkdownBudgetErrorFallsBackToSections() {
  const renderPolicy = createRenderPolicy({
    markdownMessageRenderingEnabled: true,
    markdownToolMessageRenderingEnabled: true,
    markdownRenderMaxChars: 200_000
  });
  const message = createMessage({
    id: "assistant-deep-nesting",
    kind: "assistant",
    content: `${">".repeat(40)} too deep`,
    blocks: [
      {
        content: `${">".repeat(40)} too deep`
      }
    ]
  });

  const entry = testing.buildRenderedMessageEntries(
    [message],
    null,
    80,
    renderPolicy,
    new Set<string>(),
    "ALYCE",
    null,
    null
  )[0];

  assert.ok(entry);
  assert.equal(entry?.markdownPlan, undefined);
  assert.ok((entry?.sections.length ?? 0) > 0);
}

function flattenSections(entry: TestMessageEntry) {
  return entry.sections.flatMap((section) => section.lines.map((line) => line.content));
}

runTests();
