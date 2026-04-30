import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  buildMarkdownRenderPlan,
  MarkdownRenderer,
  shouldRenderMarkdownMessage,
  type MarkdownRenderPlan
} from "./MarkdownRenderer.js";
import { Box, ScrollBox, Text, type ScrollBoxHandle } from "../runtime/ink.js";
import type { MouseEvent as TerminalMouseEvent } from "../runtime/ink-runtime/events/mouse-event.js";
import type { Color } from "../runtime/ink-runtime/styles.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone
} from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { wrapText } from "../utils/text.js";

const SCROLL_HEADROOM_ROWS = 2;
const MESSAGE_CONTENT_WIDTH_OFFSET = 13;
const SCROLLBAR_FADE_MS = 900;
const SCROLLBAR_TRACK_CHAR = "╎╎";
const SCROLLBAR_THUMB_IDLE_CHAR = "││";
const SCROLLBAR_THUMB_ACTIVE_CHAR = "┃┃";
const SCROLLBAR_WIDTH = 2;

function isHandleAtBottom(handle: ScrollBoxHandle) {
  const scrollTop = handle.getScrollTop();
  const viewportHeight = handle.getViewportHeight();
  const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());

  return scrollTop + viewportHeight >= Math.max(0, scrollHeight - SCROLL_HEADROOM_ROWS);
}

type RenderedSection = {
  label?: string;
  lines: RenderedSectionLine[];
  tone: TerminalUiMessageBlockTone;
  style: TerminalUiMessageBlockStyle;
  isDiff?: boolean;
};

type ThemeColor = Color;
type DiffLineKind = "meta" | "hunk" | "add" | "remove" | "context";

type RenderedSectionLine = {
  content: string;
  diffKind?: DiffLineKind;
};

type RenderedMessageEntry = {
  message: TerminalUiMessage;
  isSelected: boolean;
  headerLabel: string;
  headerTitle?: string;
  sections: RenderedSection[];
  markdownPlan?: MarkdownRenderPlan;
  metadataLine?: string;
<<<<<<< HEAD
=======
  isToolExpandable: boolean;
>>>>>>> 3154985 (Refine transcript diff rendering)
  leadingSpacingRows: number;
  unseenDividerRows: number;
  palette: MessagePalette;
  rowCount: number;
};

type MessagePalette = {
  headerColor: ThemeColor;
  bodyColor: ThemeColor;
  mutedColor: ThemeColor;
  railColor: ThemeColor;
};

type ScrollIndicatorState = {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
  visible: boolean;
  active: boolean;
};

type ScrollIndicatorLine = {
  key: string;
  char: string;
  color: ThemeColor;
  dimColor?: boolean;
};

type ScrollIndicatorMetrics = {
  height: number;
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
  maxThumbTop: number;
  maxScrollTop: number;
};

<<<<<<< HEAD
=======
type ExpandableRenderState = {
  sections: RenderedSection[];
  metadataLine?: string;
  expandable: boolean;
  expanded: boolean;
};

function SelectionSafeRow(props: React.ComponentProps<typeof Text>) {
  const { children, backgroundColor, ...textProps } = props;
  const rowBackgroundColor = backgroundColor as ThemeColor | undefined;

  return (
    <Box flexDirection="row" width="100%" backgroundColor={rowBackgroundColor}>
      <Text {...textProps} backgroundColor={backgroundColor}>{children}</Text>
      <Box flexGrow={1} noSelect backgroundColor={rowBackgroundColor} />
    </Box>
  );
}

>>>>>>> 3154985 (Refine transcript diff rendering)
export type MessageListHandle = {
  scrollBy: (delta: number) => void;
  scrollPage: (delta: -1 | 1) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  getDetailTargetMessageId: () => string | null;
};

function getMessageBadge(kind: TerminalUiMessage["kind"]) {
  switch (kind) {
    case "user":
      return { label: "USER" };
    case "assistant":
      return { label: "ALYCE" };
    case "thinking":
      return { label: "THINK" };
    case "tool":
      return { label: "TOOL" };
    case "error":
      return { label: "ERROR" };
    case "system":
    default:
      return { label: "SYSTEM" };
  }
}

function getMessagePalette(
  kind: TerminalUiMessage["kind"],
  isSelected: boolean
): MessagePalette {
  const makePalette = (headerColor: ThemeColor, bodyColor: ThemeColor, mutedColor: ThemeColor): MessagePalette => ({
    headerColor,
    bodyColor,
    mutedColor: isSelected ? terminalUiTheme.colors.muted : mutedColor,
    railColor: headerColor
  });

  switch (kind) {
    case "user":
      return makePalette(
        terminalUiTheme.colors.code,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "assistant":
      return makePalette(
        terminalUiTheme.colors.assistant,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "thinking":
      return makePalette(
        terminalUiTheme.colors.thinking,
        terminalUiTheme.colors.messageCardMuted,
        terminalUiTheme.colors.subtle
      );
    case "tool":
      return makePalette(
        terminalUiTheme.colors.tool,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "error":
      return makePalette(
        terminalUiTheme.colors.danger,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "system":
    default:
      return makePalette(
        terminalUiTheme.colors.code,
        terminalUiTheme.colors.code,
        terminalUiTheme.colors.muted
      );
  }
}

function getToneColor(
  tone: TerminalUiMessageBlockTone,
  kind: TerminalUiMessage["kind"],
  palette: MessagePalette
) {
  if (kind === "system" && tone !== "danger") {
    return terminalUiTheme.colors.code;
  }

  switch (tone) {
    case "muted":
      return palette.mutedColor;
    case "info":
      return terminalUiTheme.colors.info;
    case "success":
      return terminalUiTheme.colors.success;
    case "warning":
      return terminalUiTheme.colors.warning;
    case "danger":
      return terminalUiTheme.colors.danger;
    case "default":
    default:
      return kind === "thinking" ? palette.mutedColor : palette.bodyColor;
  }
}

function renderSections(blocks: TerminalUiMessageBlock[], width: number): RenderedSection[] {
  const safeWidth = Math.max(12, width);
  return blocks.map((block) => buildRenderedSection(block, safeWidth));
}

function buildRenderedSection(block: TerminalUiMessageBlock, width: number): RenderedSection {
  return {
    label: block.label,
    lines: renderBlockLines(block, width),
    tone: block.tone ?? "default",
    style: block.style ?? "plain",
    isDiff: isDiffPatchBlock(block)
  };
}

function renderBlockLines(block: TerminalUiMessageBlock, width: number): RenderedSectionLine[] {
  if (isDiffPatchBlock(block)) {
    return wrapDiffPatchLines(block.content, width);
  }

  return wrapText(block.content, width).map((content) => ({ content }));
}

function isDiffPatchBlock(block: TerminalUiMessageBlock) {
  return block.style === "code" && block.label === "Patch";
}

function wrapDiffPatchLines(content: string, width: number): RenderedSectionLine[] {
  return content
    .split(/\r?\n/)
    .flatMap((rawLine) => {
      const diffKind = classifyDiffLine(rawLine);
      if (diffKind === "meta" || diffKind === "hunk") {
        return [];
      }

      const wrappedLines = wrapText(rawLine, width);

      return wrappedLines.map((line) => ({
        content: line,
        diffKind
      }));
    });
}

function classifyDiffLine(line: string): DiffLineKind | undefined {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return "meta";
  }

  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (line.startsWith("+")) {
    return "add";
  }

  if (line.startsWith("-")) {
    return "remove";
  }

  if (line.startsWith(" ")) {
    return "context";
  }

  return undefined;
}

function getRenderedLineColors(
  line: RenderedSectionLine,
  section: RenderedSection,
  messageKind: TerminalUiMessage["kind"],
  palette: MessagePalette
): {
  color: ThemeColor;
  backgroundColor?: ThemeColor;
} {
  switch (line.diffKind) {
    case "add":
      return {
        color: terminalUiTheme.colors.diffAdded,
        backgroundColor: terminalUiTheme.colors.diffAddedBackground
      };
    case "remove":
      return {
        color: terminalUiTheme.colors.diffRemoved,
        backgroundColor: terminalUiTheme.colors.diffRemovedBackground
      };
    case "meta":
      return {
        color: terminalUiTheme.colors.diffMeta
      };
    case "hunk":
      return {
        color: terminalUiTheme.colors.diffHunk
      };
    case "context":
      return {
        color: terminalUiTheme.colors.code
      };
    default:
      return {
        color:
          section.style === "code"
            ? terminalUiTheme.colors.code
            : getToneColor(section.tone, messageKind, palette)
      };
  }
}

function getRenderableToolBlocks(
  blocks: TerminalUiMessageBlock[],
  toolData: TerminalUiToolData
) {
  if (toolData.resultKind !== "edit") {
    return blocks;
  }

  return blocks.filter((block) => block.label !== "Edit");
}

function buildCollapsedRenderedSections(
  blocks: TerminalUiMessageBlock[],
  width: number,
  maxLines: number
): {
  sections: RenderedSection[];
  truncated: boolean;
} {
  const previewSections: RenderedSection[] = [];
  let remainingLines = Math.max(1, maxLines);
  let truncated = false;

  for (const block of blocks) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    const section = buildRenderedSection(block, width);
    if (section.lines.length === 0) {
      continue;
    }

    const visibleLineCount = Math.min(section.lines.length, remainingLines);
    previewSections.push({
      ...section,
      lines: section.lines.slice(0, visibleLineCount)
    });

    truncated ||= section.lines.length > visibleLineCount;
    remainingLines -= visibleLineCount;
    if (section.lines.length > visibleLineCount) {
      break;
    }
  }

  if (previewSections.length === 0) {
    previewSections.push({
      label: "Output",
      lines: [{ content: "(empty)" }],
      tone: "muted",
      style: "plain"
    });
  }

  return {
    sections: previewSections,
    truncated
  };
}

function shouldDisplaySectionLabel(section: RenderedSection) {
  return Boolean(section.label) && !section.isDiff;
}

<<<<<<< HEAD
=======
function renderToolMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const toolData = message.toolData;
  const baseMetadata = message.metadata;

  if (!toolData) {
    return renderLegacyToolMessageState(message, width, expanded);
  }

  if (toolData.phase === "start") {
    return {
      sections: [],
      metadataLine: baseMetadata.length > 0 ? baseMetadata.join(" | ") : undefined,
      expandable: false,
      expanded: false
    };
  }

  if (toolData.ok === false) {
    return {
      sections: renderSections(getRenderableToolBlocks(message.blocks, toolData), width),
      metadataLine: baseMetadata.length > 0 ? baseMetadata.join(" | ") : undefined,
      expandable: false,
      expanded: false
    };
  }

  if (toolData.resultKind === "edit") {
    const renderableBlocks = getRenderableToolBlocks(message.blocks, toolData);
    const collapsedPreview = buildCollapsedRenderedSections(renderableBlocks, width, 12);
    const sections = expanded
      ? renderSections(renderableBlocks, width)
      : collapsedPreview.sections;
    const toggleHint = collapsedPreview.truncated
      ? expanded
        ? "Click to collapse"
        : "Click to expand"
      : undefined;

    return {
      sections,
      metadataLine: buildExpandableMetadataLine(baseMetadata, toggleHint),
      expandable: Boolean(toggleHint),
      expanded
    };
  }

  const collapsedPreview = buildCollapsedToolBlocks(message, toolData, width);
  const renderableBlocks = getRenderableToolBlocks(message.blocks, toolData);
  const sections = renderSections(expanded ? renderableBlocks : collapsedPreview.blocks, width);
  const toggleHint = collapsedPreview.truncated
    ? expanded
      ? "Click to collapse"
      : "Click to expand"
    : undefined;

  return {
    sections,
    metadataLine: buildExpandableMetadataLine(baseMetadata, toggleHint),
    expandable: Boolean(toggleHint),
    expanded
  };
}

function renderLegacyToolMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const baseMetadata = message.metadata;

  if (baseMetadata.includes("Tool call")) {
    return {
      sections: [],
      metadataLine: baseMetadata.length > 0 ? baseMetadata.join(" | ") : undefined,
      expandable: false,
      expanded: false
    };
  }

  const collapsedPreview = buildCollapsedLegacyToolBlocks(message, width);
  const sections = renderSections(expanded ? message.blocks : collapsedPreview.blocks, width);
  const toggleHint = collapsedPreview.truncated
    ? expanded
      ? "Click to collapse"
      : "Click to expand"
    : undefined;

  return {
    sections,
    metadataLine: buildExpandableMetadataLine(baseMetadata, toggleHint),
    expandable: Boolean(toggleHint),
    expanded
  };
}

function isContextPreviewMessage(message: TerminalUiMessage) {
  return message.kind === "system" && message.title === "Context Preview";
}

function renderContextPreviewMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const baseMetadata = message.metadata;
  const collapsedPreview = buildCollapsedMessageBlocks(message.blocks, width, 16);
  const sections = renderSections(expanded ? message.blocks : collapsedPreview.blocks, width);
  const toggleHint = collapsedPreview.truncated
    ? expanded
      ? "Click to collapse"
      : "Click to expand"
    : undefined;

  return {
    sections,
    metadataLine: buildExpandableMetadataLine(baseMetadata, toggleHint),
    expandable: Boolean(toggleHint),
    expanded
  };
}

function buildCollapsedMessageBlocks(
  blocks: TerminalUiMessageBlock[],
  width: number,
  maxLines: number
): {
  blocks: TerminalUiMessageBlock[];
  truncated: boolean;
} {
  const safeWidth = Math.max(16, width);
  const previewBlocks: TerminalUiMessageBlock[] = [];
  let remainingLines = maxLines;
  let truncated = false;

  for (const block of blocks) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    const preview = wrapTextClamped(block.content, safeWidth, remainingLines);
    previewBlocks.push({
      ...block,
      content: preview.lines.join("\n")
    });

    truncated ||= preview.truncated;
    remainingLines -= preview.lines.length;
    if (preview.truncated) {
      break;
    }
  }

  if (previewBlocks.length === 0) {
    previewBlocks.push({
      label: "Output",
      content: "(empty)",
      tone: "muted"
    });
  }

  return {
    blocks: previewBlocks,
    truncated
  };
}

function buildCollapsedLegacyToolBlocks(
  message: TerminalUiMessage,
  width: number
): {
  blocks: TerminalUiMessageBlock[];
  truncated: boolean;
} {
  return buildCollapsedMessageBlocks(message.blocks, width, 10);
}

function buildCollapsedToolBlocks(
  message: TerminalUiMessage,
  toolData: TerminalUiToolData,
  width: number
): {
  blocks: TerminalUiMessageBlock[];
  truncated: boolean;
} {
  const safeWidth = Math.max(16, width);

  switch (toolData.resultKind) {
    case "shell": {
      const shell = toolData.shell;
      if (!shell) {
        break;
      }

      const blocks: TerminalUiMessageBlock[] = [
        {
          label: "Command",
          content: `$ ${shell.command}`,
          style: "code"
        }
      ];
      const combinedOutput = combineShellOutput(shell.stdout, shell.stderr);
      if (!combinedOutput) {
        blocks.push({
          content: "(no output)",
          tone: "muted"
        });
        return { blocks, truncated: false };
      }

      const preview = wrapTextClamped(combinedOutput.text, safeWidth, 10);
      blocks.push({
        label: combinedOutput.label,
        content: preview.lines.join("\n"),
        style: "code",
        tone: combinedOutput.tone
      });
      return {
        blocks,
        truncated: preview.truncated
      };
    }
    case "generic":
      return buildCollapsedMessageBlocks(message.blocks, width, 3);
    case "write":
    case "edit":
    default: {
      return buildCollapsedMessageBlocks(message.blocks, width, 12);
    }
  }

  return buildCollapsedMessageBlocks(message.blocks, width, 12);
}

function combineShellOutput(stdout: string, stderr: string): {
  label: string;
  text: string;
  tone?: TerminalUiMessageBlockTone;
} | null {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout && trimmedStderr) {
    return {
      label: "Output",
      text: `${trimmedStdout}\n\n[stderr]\n${trimmedStderr}`,
      tone: "warning"
    };
  }

  if (trimmedStdout) {
    return {
      label: "Stdout",
      text: trimmedStdout,
      tone: "success"
    };
  }

  if (trimmedStderr) {
    return {
      label: "Stderr",
      text: trimmedStderr,
      tone: "warning"
    };
  }

  return null;
}

function buildExpandableMetadataLine(metadata: string[], toggleHint?: string) {
  const parts = toggleHint ? [...metadata, toggleHint] : metadata;
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

>>>>>>> 3154985 (Refine transcript diff rendering)
function buildRenderedMessageEntries(
  messages: TerminalUiMessage[],
  selectedMessageId: string | null,
  contentWidth: number,
<<<<<<< HEAD
  markdownEnabled: boolean
=======
  markdownEnabled: boolean,
  expandedToolMessageIds: ReadonlySet<string>,
  assistantLabel: string,
  unseenDividerMessageId: string | null
>>>>>>> 3154985 (Refine transcript diff rendering)
): RenderedMessageEntry[] {
  return messages.map((message, index) => {
    const isSelected = message.id === selectedMessageId;
    const badge = getMessageBadge(message.kind);
    const palette = getMessagePalette(message.kind, isSelected);
    const bodyWidth = Math.max(16, contentWidth);
    const markdownPlan = shouldRenderMarkdownMessage(message.kind, markdownEnabled)
      ? buildMarkdownRenderPlan(message.content, bodyWidth)
      : undefined;
    const sections = markdownPlan
      ? []
      : renderSections(message.blocks, contentWidth);
    const headerTitle =
      message.kind === "user" || message.kind === "assistant"
        ? undefined
        : message.title;
    const metadataLine = message.metadata.length > 0 ? message.metadata.join(" | ") : undefined;
    const leadingSpacingRows = index === 0 ? 0 : 1;
    const unseenDividerRows = message.id === unseenDividerMessageId ? 1 : 0;
    const sectionRowCount = markdownPlan
        ? markdownPlan.rowCount
        : sections.reduce((sum, section) => {
          return sum + section.lines.length + (shouldDisplaySectionLabel(section) ? 1 : 0);
        }, 0);

    return {
      message,
      isSelected,
      headerLabel: badge.label,
      headerTitle,
      sections,
      markdownPlan,
      metadataLine,
<<<<<<< HEAD
=======
      isToolExpandable: expandableRenderState?.expandable ?? false,
>>>>>>> 3154985 (Refine transcript diff rendering)
      leadingSpacingRows,
      unseenDividerRows,
      palette,
      rowCount:
        leadingSpacingRows +
        unseenDividerRows +
        1 +
        sectionRowCount +
        (metadataLine ? 1 : 0)
    };
  });
}

function buildScrollIndicatorLines(state: ScrollIndicatorState): ScrollIndicatorLine[] {
  const metrics = resolveScrollIndicatorMetrics(state);
  if (!metrics.visible || metrics.height === 0) {
    return Array.from({ length: metrics.height }, (_, index) => ({
      key: `scroll-indicator-empty-${index}`,
      char: " ",
      color: terminalUiTheme.colors.scrollbarTrack,
      dimColor: true
    }));
  }

  return Array.from({ length: metrics.height }, (_, index) => {
    const isThumb = index >= metrics.thumbTop && index < metrics.thumbTop + metrics.thumbHeight;
    return {
      key: `scroll-indicator-${index}`,
      char: isThumb
        ? (state.active ? SCROLLBAR_THUMB_ACTIVE_CHAR : SCROLLBAR_THUMB_IDLE_CHAR)
        : SCROLLBAR_TRACK_CHAR,
      color: isThumb
        ? (state.active ? terminalUiTheme.colors.scrollbarThumbActive : terminalUiTheme.colors.scrollbarThumb)
        : terminalUiTheme.colors.scrollbarTrack,
      dimColor: !isThumb
    };
  });
}

function resolveScrollIndicatorMetrics(state: ScrollIndicatorState): ScrollIndicatorMetrics {
  const height = Math.max(0, state.viewportHeight);
  if (!state.visible || height === 0 || state.scrollHeight <= state.viewportHeight) {
    return {
      height,
      visible: false,
      thumbHeight: 0,
      thumbTop: 0,
      maxThumbTop: 0,
      maxScrollTop: 0
    };
  }

  const maxScrollTop = Math.max(1, state.scrollHeight - state.viewportHeight);
  const minimumThumbHeight = height >= 6 ? 2 : 1;
  const thumbHeight = Math.min(
    height,
    Math.max(minimumThumbHeight, Math.round((state.viewportHeight / state.scrollHeight) * height))
  );
  const maxThumbTop = Math.max(0, height - thumbHeight);
  const thumbTop = Math.min(
    maxThumbTop,
    Math.max(0, Math.round((state.scrollTop / maxScrollTop) * maxThumbTop))
  );

  return {
    height,
    visible: true,
    thumbHeight,
    thumbTop,
    maxThumbTop,
    maxScrollTop
  };
}

function resolveDetailTargetMessageId(
  renderedEntries: RenderedMessageEntry[],
  entryOffsets: number[],
  scrollTop: number,
  viewportHeight: number
) {
  if (renderedEntries.length === 0) {
    return null;
  }

  const viewportBottom = scrollTop + Math.max(1, viewportHeight) - 1;
  for (let index = renderedEntries.length - 1; index >= 0; index -= 1) {
    if ((entryOffsets[index] ?? 0) <= viewportBottom) {
      return renderedEntries[index]?.message.id ?? renderedEntries.at(-1)?.message.id ?? null;
    }
  }

  return renderedEntries[0]?.message.id ?? null;
}

const MessageListImpl = forwardRef<MessageListHandle, {
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  viewportWidth: number;
  markdownEnabled: boolean;
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  onStickyChange: (sticky: boolean) => void;
}>(function MessageList(props, ref) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const scrollIndicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollDragOffsetRef = useRef<number | null>(null);
  const detailTargetMessageIdRef = useRef<string | null>(props.selectedMessageId);
  const selectedMessageSnapshotRef = useRef<string | null>(props.selectedMessageId);
  const stickySnapshotRef = useRef(true);
  const [scrollIndicator, setScrollIndicator] = useState<ScrollIndicatorState>({
    scrollTop: 0,
    viewportHeight: 0,
    scrollHeight: 0,
    visible: false,
    active: false
  });
  const layoutSignatureRef = useRef<{
    contentWidth: number;
    messageCount: number;
    totalRowCount: number;
  } | null>(null);
  const contentWidth = Math.max(24, props.viewportWidth - MESSAGE_CONTENT_WIDTH_OFFSET);
  const renderedEntries = useMemo(
    () =>
      buildRenderedMessageEntries(
        props.messages,
        props.selectedMessageId,
        contentWidth,
<<<<<<< HEAD
        props.markdownEnabled
      ),
    [contentWidth, props.markdownEnabled, props.messages, props.selectedMessageId]
=======
        props.markdownEnabled,
        expandedToolMessageIds,
        props.assistantLabel,
        props.unseenDividerMessageId
      ),
    [
      contentWidth,
      expandedToolMessageIds,
      props.assistantLabel,
      props.markdownEnabled,
      props.messages,
      props.selectedMessageId,
      props.unseenDividerMessageId
    ]
>>>>>>> 3154985 (Refine transcript diff rendering)
  );
  const totalRowCount = useMemo(
    () => renderedEntries.reduce((sum, entry) => sum + entry.rowCount, 0),
    [renderedEntries]
  );
  const entryOffsets = useMemo(() => {
    let offset = 0;
    return renderedEntries.map((entry) => {
      const top = offset;
      offset += entry.rowCount;
      return top;
    });
  }, [renderedEntries]);
  const scrollIndicatorLines = useMemo(
    () => buildScrollIndicatorLines(scrollIndicator),
    [scrollIndicator]
  );

  function armScrollIndicatorFade() {
    if (scrollIndicatorTimeoutRef.current) {
      clearTimeout(scrollIndicatorTimeoutRef.current);
    }
    scrollIndicatorTimeoutRef.current = setTimeout(() => {
      scrollIndicatorTimeoutRef.current = null;
      setScrollIndicator((previous) => (
        previous.active
          ? {
              ...previous,
              active: false
            }
          : previous
      ));
    }, SCROLLBAR_FADE_MS);
  }

  function activateScrollIndicator() {
    setScrollIndicator((previous) => (
      previous.visible && !previous.active
        ? {
            ...previous,
            active: true
          }
        : previous
    ));
    armScrollIndicatorFade();
  }

  function getCurrentScrollIndicatorState() {
    const handle = scrollRef.current;
    if (!handle) {
      return null;
    }

    const viewportHeight = handle.getViewportHeight();
    const scrollHeight = Math.max(
      handle.getScrollHeight(),
      handle.getFreshScrollHeight()
    );

    return {
      scrollTop: handle.getScrollTop(),
      viewportHeight,
      scrollHeight,
      visible: scrollHeight > viewportHeight,
      active: true
    } satisfies ScrollIndicatorState;
  }

  function applyScrollbarPosition(localRow: number, dragOffset: number) {
    const handle = scrollRef.current;
    const nextState = getCurrentScrollIndicatorState();
    if (!handle || !nextState) {
      return;
    }

    const metrics = resolveScrollIndicatorMetrics(nextState);
    if (!metrics.visible) {
      return;
    }

    const thumbTop = Math.max(
      0,
      Math.min(metrics.maxThumbTop, Math.round(localRow - dragOffset))
    );
    const scrollTop =
      metrics.maxThumbTop === 0
        ? 0
        : Math.round((thumbTop / metrics.maxThumbTop) * metrics.maxScrollTop);

    handle.scrollTo(scrollTop);
    activateScrollIndicator();
  }

  function handleScrollbarMouseDown(event: TerminalMouseEvent) {
    if (event.button !== 0) {
      return;
    }

    const nextState = getCurrentScrollIndicatorState();
    if (!nextState) {
      return;
    }

    const metrics = resolveScrollIndicatorMetrics(nextState);
    if (!metrics.visible) {
      return;
    }

    const localRow = Math.max(0, Math.min(metrics.height - 1, event.localRow));
    const clickedThumb =
      localRow >= metrics.thumbTop && localRow < metrics.thumbTop + metrics.thumbHeight;
    const dragOffset = clickedThumb
      ? localRow - metrics.thumbTop
      : Math.floor(metrics.thumbHeight / 2);

    scrollDragOffsetRef.current = dragOffset;
    applyScrollbarPosition(localRow, dragOffset);
  }

  function handleScrollbarMouseMove(event: TerminalMouseEvent) {
    const dragOffset = scrollDragOffsetRef.current;
    if (dragOffset === null) {
      return;
    }

    const viewportHeight = Math.max(1, scrollIndicator.viewportHeight);
    const localRow = Math.max(0, Math.min(viewportHeight - 1, event.localRow));
    applyScrollbarPosition(localRow, dragOffset);
  }

  function handleScrollbarMouseUp() {
    if (scrollDragOffsetRef.current === null) {
      return;
    }

    scrollDragOffsetRef.current = null;
    armScrollIndicatorFade();
  }

<<<<<<< HEAD
=======
  function handleToolMessageClick(messageId: string, event: TerminalClickEvent) {
    if (event.cellIsBlank) {
      return;
    }

    setExpandedToolMessageIds((previous) => {
      const next = new Set(previous);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  useEffect(() => {
    setExpandedToolMessageIds((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const validIds = new Set(
        props.messages
          .filter((message) => message.kind === "tool" || isContextPreviewMessage(message))
          .map((message) => message.id)
      );
      const next = new Set<string>();
      let changed = false;
      for (const id of previous) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [props.messages]);

>>>>>>> 3154985 (Refine transcript diff rendering)
  useImperativeHandle(ref, () => ({
    scrollBy: (delta) => {
      scrollRef.current?.scrollBy(delta);
    },
    scrollPage: (delta) => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      const pageStep = Math.max(1, handle.getViewportHeight() - 2);
      handle.scrollBy(delta * pageStep);
    },
    scrollToTop: () => {
      scrollRef.current?.scrollTo(0);
    },
    scrollToBottom: () => {
      scrollRef.current?.scrollToBottom();
    },
    getDetailTargetMessageId: () =>
      detailTargetMessageIdRef.current ??
      props.selectedMessageId ??
      props.messages.at(-1)?.id ??
      null
  }), [props.messages, props.selectedMessageId]);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const syncScrollState = () => {
      const currentHandle = scrollRef.current;
      if (!currentHandle) {
        return;
      }

      const scrollTop = currentHandle.getScrollTop();
      const viewportHeight = currentHandle.getViewportHeight();
      const scrollHeight = Math.max(
        currentHandle.getScrollHeight(),
        currentHandle.getFreshScrollHeight()
      );
      const isAtBottom = isHandleAtBottom(currentHandle);
      const effectiveSticky = currentHandle.isSticky() || isAtBottom;

      stickySnapshotRef.current = effectiveSticky;
      props.onStickyChange(effectiveSticky);
      detailTargetMessageIdRef.current = resolveDetailTargetMessageId(
        renderedEntries,
        entryOffsets,
        scrollTop,
        viewportHeight
      );
      setScrollIndicator((previous) => {
        const visible = scrollHeight > viewportHeight;
        if (
          previous.scrollTop === scrollTop &&
          previous.viewportHeight === viewportHeight &&
          previous.scrollHeight === scrollHeight &&
          previous.visible === visible &&
          previous.active
        ) {
          return previous;
        }

        return {
          scrollTop,
          viewportHeight,
          scrollHeight,
          visible,
          active: true
        };
      });
      armScrollIndicatorFade();
    };

    syncScrollState();
    const timeout = setTimeout(syncScrollState, 0);
    const unsubscribe = handle.subscribe(syncScrollState);

    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [entryOffsets, props.onStickyChange, renderedEntries]);

  useEffect(() => {
    return () => {
      scrollDragOffsetRef.current = null;
      if (scrollIndicatorTimeoutRef.current) {
        clearTimeout(scrollIndicatorTimeoutRef.current);
        scrollIndicatorTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const nextSignature = {
      contentWidth,
      messageCount: props.messages.length,
      totalRowCount
    };
    const previousSignature = layoutSignatureRef.current;
    layoutSignatureRef.current = nextSignature;

    if (props.messages.length === 0) {
      stickySnapshotRef.current = true;
      return;
    }

    if (!previousSignature) {
      if (handle.isSticky() || isHandleAtBottom(handle)) {
        handle.scrollToBottom();
      }
      return;
    }

    const viewportChanged = previousSignature.contentWidth !== nextSignature.contentWidth;
    const contentChanged =
      previousSignature.messageCount !== nextSignature.messageCount ||
      previousSignature.totalRowCount !== nextSignature.totalRowCount;

    if (!viewportChanged && !contentChanged) {
      return;
    }

    if (stickySnapshotRef.current || handle.isSticky() || isHandleAtBottom(handle)) {
      handle.scrollToBottom();
    }
  }, [contentWidth, props.messages.length, totalRowCount]);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle || !props.selectedMessageId) {
      selectedMessageSnapshotRef.current = props.selectedMessageId;
      return;
    }

    const selectedChanged = selectedMessageSnapshotRef.current !== props.selectedMessageId;
    selectedMessageSnapshotRef.current = props.selectedMessageId;
    if (!selectedChanged) {
      return;
    }

    const selectedIndex = renderedEntries.findIndex(
      (entry) => entry.message.id === props.selectedMessageId
    );
    if (selectedIndex < 0) {
      return;
    }

    const selectedEntry = renderedEntries[selectedIndex];
    if (!selectedEntry) {
      return;
    }

    const selectedTop = entryOffsets[selectedIndex] ?? 0;
    const selectedBottom = selectedTop + Math.max(1, selectedEntry.rowCount) - 1;
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const viewportTop = handle.getScrollTop();
    const viewportBottom = viewportTop + viewportHeight - 1;

    if (selectedTop < viewportTop) {
      handle.scrollTo(Math.max(0, selectedTop));
      return;
    }

    if (selectedBottom > viewportBottom) {
      handle.scrollTo(Math.max(0, selectedBottom - viewportHeight + 1));
    }
  }, [entryOffsets, props.selectedMessageId, renderedEntries]);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      width="100%"
      overflow="hidden"
    >
      <Box
        flexDirection="row"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        paddingX={1}
        width="100%"
      >
        <ScrollBox
          ref={scrollRef}
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          minWidth={0}
          // Keep the host sticky attribute stable. Manual scrollBy/scrollTo
          // already sets the imperative sticky flag to false, so toggling the
          // prop here only risks remount/reset churn when leaving the bottom.
          stickyScroll
        >
          {props.messages.length === 0 ? (
            <Box flexDirection="column" width="100%" paddingBottom={1}>
              <Text color={terminalUiTheme.colors.muted}>No messages yet.</Text>
              <Text color={terminalUiTheme.colors.subtle}>
                Type a prompt below, or open settings before the first model request.
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column" width="100%" paddingBottom={1}>
              {renderedEntries.map((entry) => {
                const timestamp = new Date(entry.message.createdAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit"
                });
<<<<<<< HEAD
=======
                const railRowCount = Math.max(
                  1,
                  entry.rowCount - entry.leadingSpacingRows - entry.unseenDividerRows
                );
>>>>>>> 3154985 (Refine transcript diff rendering)

                return (
                  <Box
                    key={entry.message.id}
                    flexDirection="column"
                    marginTop={entry.leadingSpacingRows}
                    width="100%"
                  >
<<<<<<< HEAD
                    {props.unseenDividerMessageId === entry.message.id ? (
=======
                    {Array.from({ length: entry.leadingSpacingRows }, (_, spacerIndex) => (
                      <Box
                        key={`${entry.message.id}-spacer-${spacerIndex}`}
                        flexDirection="row"
                        width="100%"
                        noSelect="from-left-edge"
                      >
                        <Text> </Text>
                      </Box>
                    ))}
                    {entry.unseenDividerRows > 0 ? (
>>>>>>> 3154985 (Refine transcript diff rendering)
                      <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
                        -- {props.unseenMessageCount} new message{props.unseenMessageCount === 1 ? "" : "s"} --
                      </Text>
                    ) : null}
                    <Box
                      flexDirection="column"
                      width="100%"
                      borderStyle="single"
                      borderTop={false}
                      borderRight={false}
                      borderBottom={false}
                      borderLeftColor={entry.palette.railColor}
                      borderLeftDimColor={!entry.isSelected}
                      paddingLeft={1}
                    >
<<<<<<< HEAD
                      <Text wrap="truncate-end">
                        <Text color={entry.isSelected ? terminalUiTheme.colors.accent : entry.palette.mutedColor}>
                          {entry.isSelected ? ">" : " "}
                        </Text>
                        <Text color={entry.palette.headerColor}> {entry.headerLabel}</Text>
                        {entry.headerTitle ? (
                          <Text color={entry.palette.bodyColor}> · {entry.headerTitle}</Text>
=======
                      <Box
                        flexDirection="column"
                        flexShrink={0}
                        width={MESSAGE_RAIL_GUTTER_WIDTH}
                        noSelect="from-left-edge"
                      >
                        {Array.from({ length: railRowCount }, (_, rowIndex) => (
                          <Text
                            key={`${entry.message.id}-rail-${rowIndex}`}
                            color={entry.palette.railColor}
                            dimColor={!entry.isSelected}
                          >
                            {MESSAGE_RAIL_GUTTER}
                          </Text>
                        ))}
                      </Box>
                      <Box
                        flexDirection="column"
                        flexGrow={1}
                        flexShrink={1}
                        minWidth={0}
                        width="100%"
                        onClick={entry.isToolExpandable
                          ? (event) => handleToolMessageClick(entry.message.id, event)
                          : undefined}
                      >
                        <SelectionSafeRow wrap="truncate-end">
                          <Text color={entry.palette.headerColor}>{entry.headerLabel}</Text>
                          {entry.headerTitle ? (
                            <Text color={entry.palette.bodyColor}> · {entry.headerTitle}</Text>
                          ) : null}
                          <Text color={entry.palette.mutedColor}> · {timestamp}</Text>
                        </SelectionSafeRow>
                        {entry.markdownPlan ? (
                          <MarkdownRenderer
                            plan={entry.markdownPlan}
                            kind={entry.message.kind}
                            baseColor={entry.palette.bodyColor}
                          />
                        ) : (
                          entry.sections.map((section, sectionIndex) => (
                            <Box
                              key={`${entry.message.id}-section-${sectionIndex}`}
                              flexDirection="column"
                              width="100%"
                            >
                              {shouldDisplaySectionLabel(section) ? (
                                <SelectionSafeRow
                                  color={entry.palette.mutedColor}
                                  wrap="truncate-end"
                                >
                                  {section.label}
                                </SelectionSafeRow>
                              ) : null}
                              {section.lines.map((line, lineIndex) => {
                                const lineColors = getRenderedLineColors(
                                  line,
                                  section,
                                  entry.message.kind,
                                  entry.palette
                                );

                                return (
                                  <SelectionSafeRow
                                    key={`${entry.message.id}-line-${sectionIndex}-${lineIndex}`}
                                    color={lineColors.color}
                                    backgroundColor={lineColors.backgroundColor}
                                  >
                                    {line.content || " "}
                                  </SelectionSafeRow>
                                );
                              })}
                            </Box>
                          ))
                        )}
                        {entry.metadataLine ? (
                          <SelectionSafeRow
                            color={entry.palette.mutedColor}
                            wrap="truncate-end"
                          >
                            {entry.metadataLine}
                          </SelectionSafeRow>
>>>>>>> 3154985 (Refine transcript diff rendering)
                        ) : null}
                        <Text color={entry.palette.mutedColor}> · {timestamp}</Text>
                      </Text>
                      {entry.markdownPlan ? (
                        <MarkdownRenderer
                          plan={entry.markdownPlan}
                          kind={entry.message.kind}
                          baseColor={entry.palette.bodyColor}
                        />
                      ) : (
                        entry.sections.map((section, sectionIndex) => (
                          <Box
                            key={`${entry.message.id}-section-${sectionIndex}`}
                            flexDirection="column"
                            width="100%"
                          >
                            {section.label ? (
                              <Text
                                color={entry.palette.mutedColor}
                                wrap="truncate-end"
                              >
                                {section.label}
                              </Text>
                            ) : null}
                            {section.lines.map((line, lineIndex) => (
                              <Text
                                key={`${entry.message.id}-line-${sectionIndex}-${lineIndex}`}
                                color={
                                  section.style === "code"
                                    ? terminalUiTheme.colors.code
                                    : getToneColor(section.tone, entry.message.kind, entry.palette)
                                }
                              >
                                {line}
                              </Text>
                            ))}
                          </Box>
                        ))
                      )}
                      {entry.metadataLine ? (
                        <Text
                          color={entry.palette.mutedColor}
                          wrap="truncate-end"
                        >
                          {entry.metadataLine}
                        </Text>
                      ) : null}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}
        </ScrollBox>
        <Box
          flexDirection="column"
          flexShrink={0}
          width={SCROLLBAR_WIDTH}
          marginLeft={1}
          noSelect
          onMouseDown={scrollIndicator.visible ? handleScrollbarMouseDown : undefined}
          onMouseMove={scrollIndicator.visible ? handleScrollbarMouseMove : undefined}
          onMouseUp={scrollIndicator.visible ? handleScrollbarMouseUp : undefined}
          onMouseEnter={scrollIndicator.visible ? activateScrollIndicator : undefined}
          onMouseLeave={scrollIndicator.visible
            ? () => {
                if (scrollDragOffsetRef.current === null) {
                  armScrollIndicatorFade();
                }
              }
            : undefined}
        >
          {scrollIndicatorLines.map((line) => (
            <Text
              key={line.key}
              color={line.color}
              dimColor={line.dimColor}
            >
              {line.char}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
});

export const MessageList = React.memo(MessageListImpl);
