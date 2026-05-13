import assert from "node:assert/strict";
import { __MESSAGE_LIST_TESTING__ } from "./MessageList.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone
} from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
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

const testing = __MESSAGE_LIST_TESTING__ as unknown as {
  getMessagePalette: (kind: TerminalUiMessage["kind"], isSelected: boolean) => unknown;
  getRenderedLineColors: (
    line: { content: string; diffKind?: string },
    section: {
      lines: Array<{ content: string; diffKind?: string }>;
      tone: TerminalUiMessageBlockTone;
      style: TerminalUiMessageBlockStyle;
    },
    messageKind: TerminalUiMessage["kind"],
    palette: unknown
  ) => { color: string; backgroundColor?: string };
  renderBlockLines: (block: TerminalUiMessageBlock, width: number) => Array<{ content: string; diffKind?: string }>;
  buildCollapsedMessageBlocks: (
    blocks: TerminalUiMessageBlock[],
    width: number,
    maxLines: number
  ) => { blocks: TerminalUiMessageBlock[]; truncated: boolean };
  combineShellOutput: (stdout: string, stderr: string) => { label: string; text: string; tone?: string } | null;
  buildCollapsedToolBlocks: (
    message: TerminalUiMessage,
    toolData: NonNullable<TerminalUiMessage["toolData"]>,
    width: number
  ) => { blocks: TerminalUiMessageBlock[]; truncated: boolean };
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
  sliceMessagesForNonVirtualizedList: (options: {
    messages: TerminalUiMessage[];
    maxMessages: number;
    sticky: boolean;
    visibleMessageId: string | null;
    selectedMessageId: string | null;
    unseenDividerMessageId: string | null;
  }) => TerminalUiMessage[];
  resolveVisibleMessageId: (
    renderedEntries: Array<{ message: { id: string }; rowCount: number }>,
    entryOffsets: number[],
    scrollTop: number
  ) => string | null;
  resolvePrependedMessageIds: (previousIds: string[], nextIds: string[]) => string[];
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
  testReadToolCollapsedPreviewUsesThreeLines();
  testShellToolCollapsedPreviewUsesThreeLines();
  testToolCodeLinesUseToolHeaderColor();
  testSystemLinesUseSystemColor();
  testWriteToolMessagesDefaultToCollapsedAndCanExpand(renderPolicy);
  testMarkdownFriendlyToolUsesMarkdownWhenExpanded(renderPolicy);
  testMarkdownFriendlyToolStillUsesMarkdownWhenMessageContentOverBudget();
  testShellToolStaysCodeFirst(renderPolicy);
  testOverBudgetMarkdownFallsBackToSections();
  testMarkdownBudgetErrorFallsBackToSections();
  testSliceMessagesForNonVirtualizedListAnchorsAroundVisibleMessage();
  testResolveVisibleMessageIdReturnsTopVisibleEntry();
  testResolvePrependedMessageIds();
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

function testReadToolCollapsedPreviewUsesThreeLines() {
  const message = createMessage({
    id: "tool-read-collapse-1",
    kind: "tool",
    title: "Read src/demo.ts",
    content: "Content\nline-1\nline-2\nline-3\nline-4\nline-5",
    blocks: [
      {
        label: "Content",
        style: "code",
        content: "line-1\nline-2\nline-3\nline-4\nline-5"
      }
    ]
  });
  const toolData: NonNullable<TerminalUiMessage["toolData"]> = {
    phase: "result",
    toolName: "Read",
    summary: "Read src/demo.ts",
    ok: true,
    resultKind: "read",
    read: {
      type: "text",
      filePath: "src/demo.ts",
      startLine: 1,
      numLines: 5,
      totalLines: 20,
      truncated: true,
      nextOffset: 6
    }
  };

  const collapsed = testing.buildCollapsedToolBlocks(message, toolData, 80);
  const renderedLineCount = collapsed.blocks.reduce(
    (sum, block) => sum + testing.renderBlockLines(block, 80).length,
    0
  );

  assert.equal(collapsed.truncated, true);
  assert.equal(renderedLineCount <= 3, true);
}

function testShellToolCollapsedPreviewUsesThreeLines() {
  const message = createMessage({
    id: "tool-shell-collapse-1",
    kind: "tool",
    title: "PowerShell Get-ChildItem",
    content: "Command\n$ Get-ChildItem\n\nStdout\nline-1\nline-2\nline-3\nline-4",
    blocks: [
      {
        label: "Command",
        style: "code",
        content: "$ Get-ChildItem"
      },
      {
        label: "Stdout",
        style: "code",
        content: "line-1\nline-2\nline-3\nline-4"
      }
    ]
  });
  const toolData: NonNullable<TerminalUiMessage["toolData"]> = {
    phase: "result",
    toolName: "PowerShell",
    summary: "PowerShell Get-ChildItem",
    ok: true,
    resultKind: "shell",
    shell: {
      command: "Get-ChildItem",
      cwd: ".",
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "line-1\nline-2\nline-3\nline-4\n",
      stderr: "",
      durationMs: 12
    }
  };

  const collapsed = testing.buildCollapsedToolBlocks(message, toolData, 80);
  const renderedLineCount = collapsed.blocks.reduce(
    (sum, block) => sum + testing.renderBlockLines(block, 80).length,
    0
  );

  assert.equal(collapsed.truncated, true);
  assert.equal(renderedLineCount <= 3, true);
}

function testToolCodeLinesUseToolHeaderColor() {
  const section = {
    lines: [{ content: "$ npm run build" }],
    tone: "default" as const,
    style: "code" as const
  };
  const toolPalette = testing.getMessagePalette("tool", false);
  const assistantPalette = testing.getMessagePalette("assistant", false);

  assert.equal(
    testing.getRenderedLineColors(section.lines[0]!, section, "tool", toolPalette).color,
    terminalUiTheme.colors.tool
  );
  assert.equal(
    testing.getRenderedLineColors(section.lines[0]!, section, "assistant", assistantPalette).color,
    terminalUiTheme.colors.code
  );
}

function testSystemLinesUseSystemColor() {
  const plainSection = {
    lines: [{ content: "Alyce terminal UI started." }],
    tone: "default" as const,
    style: "plain" as const
  };
  const codeSection = {
    lines: [{ content: "Workspace: D:\\Code\\AlyceAgent" }],
    tone: "default" as const,
    style: "code" as const
  };
  const systemPalette = testing.getMessagePalette("system", false);

  assert.equal(
    testing.getRenderedLineColors(plainSection.lines[0]!, plainSection, "system", systemPalette).color,
    terminalUiTheme.colors.system
  );
  assert.equal(
    testing.getRenderedLineColors(codeSection.lines[0]!, codeSection, "system", systemPalette).color,
    terminalUiTheme.colors.system
  );
}

function testWriteToolMessagesDefaultToCollapsedAndCanExpand(
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

  assert.ok(expandedEntry);
  assert.ok(collapsedEntry);
  assert.match(collapsedEntry?.metadataLine ?? "", /Click to expand/);
  assert.match(expandedEntry?.metadataLine ?? "", /Click to collapse/);

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

function testSliceMessagesForNonVirtualizedListAnchorsAroundVisibleMessage() {
  const messages = Array.from({ length: 30 }, (_, index) =>
    createMessage({
      id: `message-${index + 1}`,
      content: `message-${index + 1}`,
      blocks: [{ content: `message-${index + 1}` }]
    })
  );

  const stickySlice = testing.sliceMessagesForNonVirtualizedList({
    messages,
    maxMessages: 20,
    sticky: true,
    visibleMessageId: null,
    selectedMessageId: null,
    unseenDividerMessageId: null
  });
  assert.deepEqual(stickySlice.map((message) => message.id), [
    "message-11",
    "message-12",
    "message-13",
    "message-14",
    "message-15",
    "message-16",
    "message-17",
    "message-18",
    "message-19",
    "message-20",
    "message-21",
    "message-22",
    "message-23",
    "message-24",
    "message-25",
    "message-26",
    "message-27",
    "message-28",
    "message-29",
    "message-30"
  ]);

  const anchoredSlice = testing.sliceMessagesForNonVirtualizedList({
    messages,
    maxMessages: 20,
    sticky: false,
    visibleMessageId: "message-20",
    selectedMessageId: null,
    unseenDividerMessageId: null
  });
  assert.deepEqual(
    anchoredSlice.map((message) => message.id),
    Array.from({ length: 20 }, (_, index) => `message-${index + 5}`)
  );
}

function testResolveVisibleMessageIdReturnsTopVisibleEntry() {
  const renderedEntries = [
    { message: { id: "message-1" }, rowCount: 3 },
    { message: { id: "message-2" }, rowCount: 4 },
    { message: { id: "message-3" }, rowCount: 2 }
  ];
  const entryOffsets = [0, 3, 7];

  assert.equal(testing.resolveVisibleMessageId(renderedEntries, entryOffsets, 0), "message-1");
  assert.equal(testing.resolveVisibleMessageId(renderedEntries, entryOffsets, 2), "message-1");
  assert.equal(testing.resolveVisibleMessageId(renderedEntries, entryOffsets, 3), "message-2");
  assert.equal(testing.resolveVisibleMessageId(renderedEntries, entryOffsets, 6), "message-2");
  assert.equal(testing.resolveVisibleMessageId(renderedEntries, entryOffsets, 7), "message-3");
  assert.equal(testing.resolveVisibleMessageId(renderedEntries, entryOffsets, 999), "message-3");
}

function testResolvePrependedMessageIds() {
  assert.deepEqual(
    testing.resolvePrependedMessageIds(
      ["b", "c", "d"],
      ["a", "b", "c", "d"]
    ),
    ["a"]
  );
  assert.deepEqual(
    testing.resolvePrependedMessageIds(
      ["b", "c", "d"],
      ["x", "y", "b", "c", "d"]
    ),
    ["x", "y"]
  );
  assert.deepEqual(
    testing.resolvePrependedMessageIds(
      ["b", "c", "d"],
      ["a", "b", "x", "d"]
    ),
    []
  );
}

function flattenSections(entry: TestMessageEntry) {
  return entry.sections.flatMap((section) => section.lines.map((line) => line.content));
}

runTests();
