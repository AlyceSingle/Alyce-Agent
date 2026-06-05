import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import {
  buildMarkdownRenderPlan,
  MarkdownRenderer,
  type MarkdownRenderPlan
} from "./MarkdownRenderer.js";
import { VirtualMessageList } from "./VirtualMessageList.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import ScrollBox, { type ScrollBoxHandle } from "../runtime/ink-runtime/components/ScrollBox.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import { useSelection } from "../runtime/ink-runtime/hooks/use-selection.js";
import type { MouseEvent as TerminalMouseEvent } from "../runtime/ink-runtime/events/mouse-event.js";
import type { ClickEvent as TerminalClickEvent } from "../runtime/ink-runtime/events/click-event.js";
import type { Color } from "../runtime/ink-runtime/styles.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone,
  TerminalUiToolData
} from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import {
  getRenderableToolBlocks,
  isContextPreviewMessage,
  isDiffPatchBlock
} from "../utils/messageBlocks.js";
import { normalizeMarkdownInput } from "../utils/htmlEntities.js";
import {
  advanceDiffPatchHunkTracker,
  countDiffPatchFileHeaders,
  createDiffPatchHunkTracker,
  isInsideDiffPatchHunk,
  parseDiffPatchHeaderPath,
  parseDiffPatchHunkHeader,
  setDiffPatchHunkTracker
} from "../utils/diffPatchParsing.js";
import {
  createRenderPolicy,
  resolveMessageRenderDecision,
  type RenderPolicy
} from "../utils/renderPolicy.js";
import { measureCharWidth, wrapText, wrapTextClamped } from "../utils/text.js";
import { logForDebugging } from "../runtime/utils/debug.js";
import { logLayoutTrace } from "../runtime/utils/layoutTrace.js";
import { isEnvTruthy } from "../runtime/utils/envUtils.js";
import { useVirtualScroll, type VirtualScrollRange } from "../hooks/useVirtualScroll.js";

const SCROLL_HEADROOM_ROWS = 2;
const MESSAGE_CONTENT_WIDTH_OFFSET = 14;
const MESSAGE_RAIL_GUTTER = "│ ";
const MESSAGE_RAIL_GUTTER_WIDTH = MESSAGE_RAIL_GUTTER.length;
const SCROLLBAR_FADE_MS = 900;
const SCROLLBAR_TRACK_CHAR = "╎╎";
const SCROLLBAR_THUMB_IDLE_CHAR = "││";
const SCROLLBAR_THUMB_ACTIVE_CHAR = "┃┃";
const SCROLLBAR_WIDTH = 2;
const NEAR_TOP_TRIGGER_ROWS = 1;
const SCROLL_PERF_LOG_ENABLED =
  isEnvTruthy(process.env.ALYCE_SCROLL_PERF_LOG) ||
  isEnvTruthy(process.env.CLAUDE_CODE_SCROLL_PERF_LOG);
const VIRTUAL_SCROLL_ENABLED = !isEnvTruthy(process.env.ALYCE_DISABLE_VIRTUAL_SCROLL);
const SCROLL_PERF_FLUSH_INTERVAL_MS = 1500;
const SCROLL_PERF_SLOW_SYNC_THRESHOLD_MS = 8;
const MIN_NON_VIRTUALIZED_MESSAGE_CAP = 20;
const WINDOW_ANCHOR_HEADROOM_RATIO = 0.75;
const DIFF_LINE_NUMBER_LEFT_PADDING = "  ";
const DIFF_HUNK_SEPARATOR = "⋮";

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
type DiffLineKind = "meta" | "hunk" | "file" | "separator" | "add" | "remove" | "context";

type RenderedSectionLine = {
  content: string;
  diffKind?: DiffLineKind;
  lineNumberText?: string;
};

type RenderedMessageEntry = {
  message: TerminalUiMessage;
  isSelected: boolean;
  headerSegments: HeaderSegment[];
  sections: RenderedSection[];
  markdownPlan?: MarkdownRenderPlan;
  metadataLine?: string;
  isExpandable: boolean;
  leadingSpacingRows: number;
  unseenDividerRows: number;
  palette: MessagePalette;
  rowCount: number;
};

type HeaderSegment = {
  text: string;
  color: ThemeColor;
};

const TOOL_TARGET_HEADER_COLOR = terminalUiTheme.colors.toolTarget;

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

type ExpandableRenderState = {
  sections: RenderedSection[];
  metadataLine?: string;
  expandable: boolean;
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

export type MessageListHandle = {
  scrollBy: (delta: number) => void;
  scrollPage: (delta: -1 | 1) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  refreshViewport: () => void;
  getVisibleMessageId: () => string | null;
};

function getMessageBadge(kind: TerminalUiMessage["kind"]) {
  switch (kind) {
    case "user":
      return { label: "USER" };
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
        terminalUiTheme.colors.system,
        terminalUiTheme.colors.chrome,
        terminalUiTheme.colors.muted
      );
  }
}

function buildHeaderSegments(
  message: TerminalUiMessage,
  badgeLabel: string,
  palette: MessagePalette
): HeaderSegment[] {
  const segments: HeaderSegment[] = [
    {
      text: badgeLabel,
      color: palette.headerColor
    }
  ];
  const titleSegments = buildHeaderTitleSegments(message, palette);

  if (titleSegments.length > 0) {
    segments.push(
      {
        text: " · ",
        color: palette.mutedColor
      },
      ...titleSegments
    );
  }

  return segments;
}

function buildHeaderTitleSegments(
  message: TerminalUiMessage,
  palette: MessagePalette
): HeaderSegment[] {
  if (message.kind === "user" || message.kind === "assistant") {
    return [];
  }

  if (message.kind === "tool") {
    return buildToolHeaderTitleSegments(message, palette);
  }

  return [
    {
      text: message.title,
      color: palette.headerColor
    }
  ];
}

function buildToolHeaderTitleSegments(
  message: TerminalUiMessage,
  palette: MessagePalette
): HeaderSegment[] {
  const shellCommand = message.toolData?.ok === true &&
    message.toolData.resultKind === "shell"
    ? message.toolData.shell?.command
    : undefined;
  if (shellCommand) {
    return [
      {
        text: "Ran ",
        color: terminalUiTheme.colors.chrome
      },
      ...buildShellCommandHeaderSegments(shellCommand, palette)
    ];
  }

  const title = message.title.trim();
  if (title.length === 0) {
    return [];
  }

  const splitTitle = splitFirstWhitespace(title);
  if (!splitTitle) {
    return [
      {
        text: title,
        color: terminalUiTheme.colors.chrome
      }
    ];
  }

  return [
    {
      text: splitTitle.head,
      color: terminalUiTheme.colors.chrome
    },
    {
      text: " ",
      color: palette.mutedColor
    },
    {
      text: splitTitle.tail,
      color: TOOL_TARGET_HEADER_COLOR
    }
  ];
}

function buildShellCommandHeaderSegments(
  command: string,
  palette: MessagePalette
): HeaderSegment[] {
  const tokens = splitShellCommand(command);
  if (tokens.length === 0) {
    return [
      {
        text: command,
        color: terminalUiTheme.colors.code
      }
    ];
  }

  return tokens.flatMap((token, index) => {
    const prefix = index === 0
      ? []
      : [
          {
            text: " ",
            color: palette.mutedColor
          }
        ];

    if (index > 0 && isPathLikeToolTarget(token)) {
      return [
        ...prefix,
        {
          text: token,
          color: TOOL_TARGET_HEADER_COLOR
        }
      ];
    }

    return [
      ...prefix,
      {
        text: token,
        color: getShellCommandTokenColor(token, index)
      }
    ];
  });
}

function getShellCommandTokenColor(token: string, index: number): ThemeColor {
  if (index === 0) {
    return terminalUiTheme.colors.tool;
  }

  if (/^-{1,2}\S+/.test(token)) {
    return terminalUiTheme.colors.system;
  }

  if (/^["']/.test(token)) {
    return terminalUiTheme.colors.markdownQuote;
  }

  return terminalUiTheme.colors.code;
}

function isPathLikeToolTarget(token: string) {
  const unquoted = token.replace(/^["']|["']$/g, "");
  return /^[A-Za-z]:[\\/]/.test(unquoted) ||
    unquoted.startsWith("~/") ||
    unquoted.startsWith("~\\") ||
    unquoted.startsWith("./") ||
    unquoted.startsWith(".\\") ||
    unquoted.startsWith("../") ||
    unquoted.startsWith("..\\") ||
    unquoted.includes("/") ||
    unquoted.includes("\\");
}

function splitShellCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function splitFirstWhitespace(value: string): { head: string; tail: string } | null {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(value);
  if (!match) {
    return null;
  }

  return {
    head: match[1]!,
    tail: match[2]!
  };
}

function getToneColor(
  tone: TerminalUiMessageBlockTone,
  kind: TerminalUiMessage["kind"],
  palette: MessagePalette
) {
  if (kind === "system" && tone !== "danger") {
    return palette.bodyColor;
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

  return wrapText(normalizeMarkdownInput(block.content), width).map((content) => ({ content }));
}

function wrapDiffPatchLines(content: string, width: number): RenderedSectionLine[] {
  const parsedLines = parseDiffPatchLines(content);
  const lineNumberColumnWidth = parsedLines.reduce((maxWidth, line) => {
    return line.lineNumber === undefined
      ? maxWidth
      : Math.max(maxWidth, String(line.lineNumber).length);
  }, 0);
  const lineNumberGutterWidth = lineNumberColumnWidth > 0
    ? DIFF_LINE_NUMBER_LEFT_PADDING.length + lineNumberColumnWidth + 1
    : 0;
  const contentWidth = Math.max(8, width - lineNumberGutterWidth);

  return parsedLines.flatMap((parsedLine) => {
    const wrappedLines = wrapText(parsedLine.rawLine, contentWidth);

    return wrappedLines.map((line, index) => ({
      content: line,
      diffKind: parsedLine.diffKind,
      ...(lineNumberColumnWidth > 0
        ? {
            lineNumberText:
              index === 0 && parsedLine.lineNumber !== undefined
                ? String(parsedLine.lineNumber).padStart(lineNumberColumnWidth)
                : "".padStart(lineNumberColumnWidth)
          }
        : {})
    }));
  });
}

type ParsedDiffLine = {
  rawLine: string;
  diffKind?: DiffLineKind;
  lineNumber?: number;
};

function parseDiffPatchLines(content: string): ParsedDiffLine[] {
  const parsedLines: ParsedDiffLine[] = [];
  const rawLines = content.split(/\r?\n/);
  const showFileHeaders = countDiffPatchFileHeaders(rawLines, { stripGitPrefix: true }) > 1;
  let oldLine = 1;
  let newLine = 1;
  let hasHunk = false;
  let renderedLinesInCurrentHunk = 0;
  let pendingOldPath: string | undefined;
  const hunkTracker = createDiffPatchHunkTracker();

  for (const rawLine of rawLines) {
    const insideParsedHunk = isInsideDiffPatchHunk(hunkTracker);

    if (!insideParsedHunk && rawLine.startsWith("--- ")) {
      pendingOldPath = parseDiffPatchHeaderPath(rawLine, { stripGitPrefix: true });
      continue;
    }

    if (!insideParsedHunk && rawLine.startsWith("+++ ")) {
      const newPath = parseDiffPatchHeaderPath(rawLine, { stripGitPrefix: true });
      if (showFileHeaders) {
        appendDiffFileHeader(parsedLines, newPath ?? pendingOldPath);
        hasHunk = false;
        renderedLinesInCurrentHunk = 0;
        oldLine = 1;
        newLine = 1;
      }
      pendingOldPath = undefined;
      continue;
    }

    const diffKind = classifyDiffLine(rawLine, insideParsedHunk);
    if (diffKind === "meta") {
      continue;
    }

    if (diffKind === "hunk") {
      const hunk = parseDiffPatchHunkHeader(rawLine);
      if (hunk) {
        if (renderedLinesInCurrentHunk > 0) {
          parsedLines.push({
            rawLine: DIFF_HUNK_SEPARATOR,
            diffKind: "separator"
          });
        }
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
        hasHunk = true;
        renderedLinesInCurrentHunk = 0;
        setDiffPatchHunkTracker(hunkTracker, hunk);
      }
      continue;
    }

    if (!hasHunk && (diffKind === "add" || diffKind === "remove" || diffKind === "context")) {
      oldLine = 1;
      newLine = 1;
      hasHunk = true;
    }

    if (diffKind === "add") {
      parsedLines.push({
        rawLine,
        diffKind,
        lineNumber: newLine
      });
      newLine += 1;
      renderedLinesInCurrentHunk += 1;
      advanceDiffPatchHunkTracker(hunkTracker, rawLine);
      continue;
    }

    if (diffKind === "remove") {
      parsedLines.push({
        rawLine,
        diffKind,
        lineNumber: oldLine
      });
      oldLine += 1;
      renderedLinesInCurrentHunk += 1;
      advanceDiffPatchHunkTracker(hunkTracker, rawLine);
      continue;
    }

    if (diffKind === "context") {
      parsedLines.push({
        rawLine,
        diffKind,
        lineNumber: newLine
      });
      oldLine += 1;
      newLine += 1;
      renderedLinesInCurrentHunk += 1;
      advanceDiffPatchHunkTracker(hunkTracker, rawLine);
      continue;
    }

    parsedLines.push({
      rawLine,
      diffKind
    });
  }

  return parsedLines;
}

function appendDiffFileHeader(parsedLines: ParsedDiffLine[], filePath: string | undefined) {
  if (!filePath) {
    return;
  }

  if (parsedLines.length > 0) {
    parsedLines.push({
      rawLine: "",
      diffKind: "separator"
    });
  }

  parsedLines.push({
    rawLine: filePath,
    diffKind: "file"
  });
}

function classifyDiffLine(line: string, insideHunk = false): DiffLineKind | undefined {
  if (
    (!insideHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  ) {
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
    case "file":
      return {
        color: terminalUiTheme.colors.diffMeta
      };
    case "separator":
      return {
        color: terminalUiTheme.colors.subtle
      };
    case "context":
      return {
        color: terminalUiTheme.colors.code
      };
    default:
      return {
        color:
          section.style === "code"
            ? messageKind === "system"
              ? palette.bodyColor
              : messageKind === "tool"
                ? palette.bodyColor
                : terminalUiTheme.colors.code
            : getToneColor(section.tone, messageKind, palette)
      };
  }
}

function shouldDisplaySectionLabel(section: RenderedSection) {
  return Boolean(section.label) && !section.isDiff;
}

function countRenderedSectionRows(sections: RenderedSection[]) {
  return sections.reduce((sum, section) => {
    return sum + section.lines.length + (shouldDisplaySectionLabel(section) ? 1 : 0);
  }, 0);
}

function isDefaultExpandedToolMessage(message: TerminalUiMessage) {
  return message.kind === "tool" &&
    message.toolData !== undefined &&
    isEditLikeToolResult(message.toolData.resultKind);
}

function isDefaultExpandedMessage(
  message: TerminalUiMessage,
  thinkingMessagesExpandedByDefault: boolean
) {
  return isDefaultExpandedToolMessage(message) ||
    (message.kind === "thinking" && thinkingMessagesExpandedByDefault);
}

function isMessageExpanded(
  message: TerminalUiMessage,
  expandedMessageIds: ReadonlySet<string>,
  thinkingMessagesExpandedByDefault = false
) {
  if (isDefaultExpandedMessage(message, thinkingMessagesExpandedByDefault)) {
    return !expandedMessageIds.has(message.id);
  }

  return expandedMessageIds.has(message.id);
}

function isCollapsibleSystemMessage(message: TerminalUiMessage) {
  return message.kind === "system" && message.title !== "Startup";
}

function findFirstNonEmptyLineBlock(blocks: TerminalUiMessageBlock[]): TerminalUiMessageBlock | null {
  for (const block of blocks) {
    const firstLine = block.content
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);

    if (firstLine) {
      return {
        content: firstLine,
        tone: block.tone,
        style: block.style
      };
    }
  }

  return null;
}

function buildCollapsibleSystemPreviewBlock(message: TerminalUiMessage): TerminalUiMessageBlock {
  const blockPreview = findFirstNonEmptyLineBlock(message.blocks);
  if (blockPreview) {
    return blockPreview;
  }

  const contentPreview = message.content
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return {
    content: contentPreview ?? "(empty)"
  };
}

function clampBlockToSingleRenderedLine(
  block: TerminalUiMessageBlock,
  width: number
): { block: TerminalUiMessageBlock; truncated: boolean } {
  const safeWidth = Math.max(8, width);
  let contentWidth = 0;
  for (const character of block.content) {
    contentWidth += measureCharWidth(character);
  }

  if (contentWidth <= safeWidth) {
    return { block, truncated: false };
  }

  const suffix = "...";
  const contentBudget = Math.max(0, safeWidth - suffix.length);
  let visibleContent = "";
  let visibleWidth = 0;
  for (const character of block.content) {
    const characterWidth = measureCharWidth(character);
    if (visibleWidth + characterWidth > contentBudget) {
      break;
    }

    visibleContent += character;
    visibleWidth += characterWidth;
  }

  return {
    block: {
      ...block,
      content: visibleContent.length > 0 ? `${visibleContent}${suffix}` : suffix
    },
    truncated: true
  };
}

function renderCollapsibleSystemMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const baseMetadata = message.metadata;
  const collapsedPreview = clampBlockToSingleRenderedLine(
    buildCollapsibleSystemPreviewBlock(message),
    width
  );
  const collapsedSections = renderSections([collapsedPreview.block], width);
  const expandedSections = renderSections(message.blocks, width);
  const expandable =
    collapsedPreview.truncated ||
    countRenderedSectionRows(expandedSections) > countRenderedSectionRows(collapsedSections);
  const toggleHint = expandable
    ? expanded
      ? "Click to collapse"
      : "Click to expand"
    : undefined;

  return {
    sections: expanded ? expandedSections : collapsedSections,
    metadataLine: buildExpandableMetadataLine(baseMetadata, toggleHint),
    expandable
  };
}

function renderToolMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const toolData = message.toolData;
  const renderableBlocks =
    !toolData || toolData.ok === false
      ? message.blocks
      : getRenderableToolBlocks(message.blocks, toolData);

  return renderHeaderOnlyExpandableState(message.metadata, renderableBlocks, width, expanded);
}

function renderThinkingMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  return renderHeaderOnlyExpandableState(message.metadata, message.blocks, width, expanded);
}

function isEditLikeToolResult(resultKind: TerminalUiToolData["resultKind"]) {
  return resultKind === "edit" || resultKind === "write" || resultKind === "patch";
}

function renderHeaderOnlyExpandableState(
  metadata: string[],
  blocks: TerminalUiMessageBlock[],
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const expandedSections = renderSections(blocks, width);
  const expandable = countRenderedSectionRows(expandedSections) > 0;
  const toggleHint = expandable
    ? expanded
      ? "Click to collapse"
      : "Click to expand"
    : undefined;

  return {
    sections: expanded ? expandedSections : [],
    metadataLine: buildExpandableMetadataLine(metadata, toggleHint),
    expandable
  };
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
    expandable: Boolean(toggleHint)
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

function buildCollapsedToolBlocks(
  message: TerminalUiMessage,
  toolData: TerminalUiToolData,
  width: number
): {
  blocks: TerminalUiMessageBlock[];
  truncated: boolean;
} {
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
        return buildCollapsedMessageBlocks(blocks, width, 3);
      }

      blocks.push({
        label: combinedOutput.label,
        content: combinedOutput.text,
        style: "code",
        tone: combinedOutput.tone
      });
      return buildCollapsedMessageBlocks(blocks, width, 3);
    }
    case "read":
      return buildCollapsedMessageBlocks(message.blocks, width, 3);
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

function buildToolMarkdownContent(
  blocks: readonly TerminalUiMessageBlock[]
): string | null {
  const sections = blocks.flatMap((block) => {
    const normalizedContent = normalizeMarkdownInput(block.content);
    if (normalizedContent.trim().length === 0) {
      return [];
    }

    if (!block.label) {
      return [normalizedContent];
    }

    return [`### ${block.label}\n\n${normalizedContent}`];
  });

  if (sections.length === 0) {
    return null;
  }

  return sections.join("\n\n");
}

function buildMarkdownPlanSafely(
  source: string,
  width: number,
  live: boolean,
  policyVersion: string
): MarkdownRenderPlan | undefined {
  try {
    return buildMarkdownRenderPlan(source, width, {
      live,
      policyVersion
    });
  } catch {
    return undefined;
  }
}

function buildRenderedMessageEntries(
  messages: TerminalUiMessage[],
  selectedMessageId: string | null,
  contentWidth: number,
  renderPolicy: RenderPolicy,
  expandedMessageIds: ReadonlySet<string>,
  assistantLabel: string,
  unseenDividerMessageId: string | null,
  liveMarkdownMessageId: string | null,
  thinkingMessagesExpandedByDefault = false
): RenderedMessageEntry[] {
  return messages.map((message, index) => {
    const isSelected = message.id === selectedMessageId;
    const badge =
      message.kind === "assistant"
        ? { label: assistantLabel }
        : getMessageBadge(message.kind);
    const palette = getMessagePalette(message.kind, isSelected);
    const bodyWidth = Math.max(16, contentWidth);
    const isExpanded = isMessageExpanded(
      message,
      expandedMessageIds,
      thinkingMessagesExpandedByDefault
    );
    const expandableRenderState =
      message.kind === "tool"
        ? renderToolMessageState(message, contentWidth, isExpanded)
        : message.kind === "thinking"
          ? renderThinkingMessageState(message, contentWidth, isExpanded)
          : isContextPreviewMessage(message)
            ? renderContextPreviewMessageState(message, contentWidth, isExpanded)
            : isCollapsibleSystemMessage(message)
              ? renderCollapsibleSystemMessageState(message, contentWidth, isExpanded)
              : null;
    const resolveRenderDecision = (markdownSource: string) => resolveMessageRenderDecision({
      policy: renderPolicy,
      message,
      expanded: isExpanded,
      hasExpandablePreview: expandableRenderState?.expandable ?? false,
      live: message.id === liveMarkdownMessageId,
      markdownSource
    });
    let markdownSource = message.content;
    let renderDecision = resolveRenderDecision(markdownSource);

    if (message.kind === "tool" && message.toolData) {
      const shouldResolveToolMarkdownSource =
        renderDecision.mode === "markdown" || renderDecision.fallbackReason === "content-too-long";

      if (shouldResolveToolMarkdownSource) {
        const nextToolMarkdownSource = buildToolMarkdownContent(
          isExpanded
            ? getRenderableToolBlocks(message.blocks, message.toolData)
            : buildCollapsedToolBlocks(message, message.toolData, bodyWidth).blocks
        );

        if (nextToolMarkdownSource) {
          markdownSource = nextToolMarkdownSource;
          renderDecision = resolveRenderDecision(markdownSource);
        }
      }
    }

    const markdownPlan = renderDecision.mode === "markdown"
      ? buildMarkdownPlanSafely(
          markdownSource,
          bodyWidth,
          renderDecision.live,
          renderPolicy.version
        )
      : undefined;
    const sections = markdownPlan
      ? []
      : expandableRenderState?.sections ?? renderSections(message.blocks, contentWidth);
    const metadataLine =
      expandableRenderState?.metadataLine ??
      (message.metadata.length > 0 ? message.metadata.join(" | ") : undefined);
    const leadingSpacingRows = index === 0 ? 0 : 1;
    const unseenDividerRows = message.id === unseenDividerMessageId ? 1 : 0;
    const sectionRowCount = markdownPlan
        ? markdownPlan.rowCount
        : countRenderedSectionRows(sections);

    return {
      message,
      isSelected,
      headerSegments: buildHeaderSegments(message, badge.label, palette),
      sections,
      markdownPlan,
      metadataLine,
      isExpandable: expandableRenderState?.expandable ?? false,
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

function clampNonVirtualizedMessageCap(value: number) {
  if (!Number.isFinite(value)) {
    return MIN_NON_VIRTUALIZED_MESSAGE_CAP;
  }

  return Math.max(MIN_NON_VIRTUALIZED_MESSAGE_CAP, Math.trunc(value));
}

function sliceMessagesForNonVirtualizedList(options: {
  messages: TerminalUiMessage[];
  maxMessages: number;
  sticky: boolean;
  visibleMessageId: string | null;
  selectedMessageId: string | null;
  unseenDividerMessageId: string | null;
}) {
  const cap = clampNonVirtualizedMessageCap(options.maxMessages);
  if (options.messages.length <= cap) {
    return options.messages;
  }

  if (options.sticky) {
    return options.messages.slice(options.messages.length - cap);
  }

  const lastMessageId = options.messages.at(-1)?.id ?? null;
  const selectedAnchorCandidate =
    options.selectedMessageId && options.selectedMessageId !== lastMessageId
      ? options.selectedMessageId
      : null;
  const anchorCandidates = [
    selectedAnchorCandidate,
    options.visibleMessageId,
    options.unseenDividerMessageId,
    options.selectedMessageId,
    lastMessageId
  ].filter((value): value is string => Boolean(value));

  let anchorIndex = -1;
  for (const candidate of anchorCandidates) {
    const index = options.messages.findIndex((message) => message.id === candidate);
    if (index >= 0) {
      anchorIndex = index;
      break;
    }
  }

  if (anchorIndex < 0) {
    return options.messages.slice(options.messages.length - cap);
  }

  const headroom = Math.max(1, Math.floor(cap * WINDOW_ANCHOR_HEADROOM_RATIO));
  const maxStart = options.messages.length - cap;
  const unclampedStart = anchorIndex - headroom;
  const start = Math.max(0, Math.min(unclampedStart, maxStart));
  return options.messages.slice(start, start + cap);
}

export const __MESSAGE_LIST_TESTING__ = {
  getMessagePalette,
  getRenderedLineColors,
  renderBlockLines,
  buildCollapsedMessageBlocks,
  buildCollapsedToolBlocks,
  combineShellOutput,
  buildHeaderSegments,
  buildShellCommandHeaderSegments,
  renderToolMessageState,
  buildRenderedMessageEntries,
  sliceMessagesForNonVirtualizedList,
  resolveVisibleMessageId,
  resolvePrependedMessageIds
} as const;

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

function resolveVisibleMessageId(
  renderedEntries: RenderedMessageEntry[],
  entryOffsets: number[],
  scrollTop: number
) {
  if (renderedEntries.length === 0) {
    return null;
  }

  const viewportTop = Math.max(0, Math.floor(scrollTop));
  let left = 0;
  let right = entryOffsets.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const top = entryOffsets[middle] ?? 0;
    const bottomExclusive = top + Math.max(1, renderedEntries[middle]?.rowCount ?? 1);
    if (bottomExclusive <= viewportTop) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  const index = Math.max(0, Math.min(renderedEntries.length - 1, left));
  if (index >= 0) {
    return renderedEntries[index]?.message.id ?? renderedEntries.at(-1)?.message.id ?? null;
  }

  return renderedEntries[0]?.message.id ?? null;
}

function resolvePrependedMessageIds(previousIds: string[], nextIds: string[]) {
  if (previousIds.length === 0 || nextIds.length <= previousIds.length) {
    return [];
  }

  const prependCount = nextIds.length - previousIds.length;
  for (let index = 0; index < previousIds.length; index += 1) {
    if (nextIds[prependCount + index] !== previousIds[index]) {
      return [];
    }
  }

  return nextIds.slice(0, prependCount);
}

const TranscriptRows = React.memo(function TranscriptRows(props: {
  renderedEntries: RenderedMessageEntry[];
  virtualRange: VirtualScrollRange;
  unseenMessageCount: number;
  onExpandableMessageClick: (message: TerminalUiMessage, event: TerminalClickEvent) => void;
}) {
  const renderMessageEntry = useCallback((entry: RenderedMessageEntry) => {
    const timestamp = new Date(entry.message.createdAt).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
    const railRowCount = Math.max(
      1,
      entry.rowCount - entry.leadingSpacingRows - entry.unseenDividerRows
    );

    return (
      <Box
        key={entry.message.id}
        flexDirection="column"
        width="100%"
      >
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
          <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
            -- {props.unseenMessageCount} new message{props.unseenMessageCount === 1 ? "" : "s"} --
          </Text>
        ) : null}
        <Box
          flexDirection="row"
          width="100%"
        >
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
            onClick={entry.isExpandable
              ? (event) => props.onExpandableMessageClick(entry.message, event)
              : undefined}
          >
            <SelectionSafeRow wrap="truncate-end">
              {entry.headerSegments.map((segment, index) => (
                <Text key={`${entry.message.id}-header-${index}`} color={segment.color}>
                  {segment.text}
                </Text>
              ))}
              <Text color={entry.palette.mutedColor}> · {timestamp}</Text>
            </SelectionSafeRow>
            {entry.markdownPlan ? (
              <MarkdownRenderer
                plan={entry.markdownPlan}
                kind={entry.message.kind}
                baseColor={entry.palette.bodyColor}
                colorMode={entry.message.kind === "tool" ? "plain" : "semantic"}
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
                        {line.lineNumberText !== undefined ? (
                          <Text
                            color={terminalUiTheme.colors.subtle}
                            backgroundColor={lineColors.backgroundColor}
                          >
                            {DIFF_LINE_NUMBER_LEFT_PADDING}{line.lineNumberText}{" "}
                          </Text>
                        ) : null}
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
            ) : null}
          </Box>
        </Box>
      </Box>
    );
  }, [props.onExpandableMessageClick, props.unseenMessageCount]);

  if (props.renderedEntries.length === 0) {
    return (
      <Box flexDirection="column" width="100%" paddingBottom={1}>
        <Text color={terminalUiTheme.colors.muted}>No messages yet.</Text>
        <Text color={terminalUiTheme.colors.subtle}>
          Type a prompt below, or open settings before the first model request.
        </Text>
      </Box>
    );
  }

  return (
    <VirtualMessageList
      entries={props.renderedEntries}
      range={props.virtualRange}
      renderEntry={renderMessageEntry}
    />
  );
});

const MessageListImpl = forwardRef<MessageListHandle, {
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  viewportWidth: number;
  markdownEnabled: boolean;
  markdownToolMessageRenderingEnabled: boolean;
  markdownRenderMaxChars: number;
  thinkingMessagesExpandedByDefault: boolean;
  maxMessagesWithoutVirtualization: number;
  isLoading: boolean;
  assistantLabel: string;
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  onStickyChange: (sticky: boolean) => void;
  onNearTop?: (visibleMessageId: string | null) => void;
}>(function MessageList(props, ref) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const scrollIndicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollDragOffsetRef = useRef<number | null>(null);
  const visibleMessageIdRef = useRef<string | null>(props.selectedMessageId);
  const selectedMessageSnapshotRef = useRef<string | null>(props.selectedMessageId);
  const stickySnapshotRef = useRef(true);
  const nearTopSnapshotRef = useRef(false);
  const previousMessageIdsRef = useRef<string[]>(props.messages.map((message) => message.id));
  const pendingPrependMessageIdsRef = useRef<string[]>([]);
  const thinkingDefaultExpandedRef = useRef(props.thinkingMessagesExpandedByDefault);
  const selection = useSelection();
  const [expandedMessageIds, setExpandedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
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
  const layoutPerfSignatureRef = useRef<string | null>(null);
  const scrollSyncPerfRef = useRef({
    sampleCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastFlushAtMs: Date.now()
  });
  const contentWidth = Math.max(24, props.viewportWidth - MESSAGE_CONTENT_WIDTH_OFFSET);
  const stickySnapshot = stickySnapshotRef.current;
  const visibleMessageIdSnapshot = visibleMessageIdRef.current;
  const sourceMessages = useMemo(
    () => {
      if (VIRTUAL_SCROLL_ENABLED) {
        return props.messages;
      }

      return sliceMessagesForNonVirtualizedList({
        messages: props.messages,
        maxMessages: props.maxMessagesWithoutVirtualization,
        sticky: stickySnapshot,
        visibleMessageId: visibleMessageIdSnapshot,
        selectedMessageId: props.selectedMessageId,
        unseenDividerMessageId: props.unseenDividerMessageId
      });
    },
    [
      props.maxMessagesWithoutVirtualization,
      props.messages,
      props.selectedMessageId,
      props.unseenDividerMessageId,
      stickySnapshot,
      visibleMessageIdSnapshot
    ]
  );
  const renderPolicy = useMemo(
    () =>
      createRenderPolicy({
        markdownMessageRenderingEnabled: props.markdownEnabled,
        markdownToolMessageRenderingEnabled: props.markdownToolMessageRenderingEnabled,
        markdownRenderMaxChars: props.markdownRenderMaxChars
      }),
    [
      props.markdownEnabled,
      props.markdownToolMessageRenderingEnabled,
      props.markdownRenderMaxChars
    ]
  );
  const liveMarkdownMessageId = useMemo(() => {
    if (!props.isLoading) {
      return null;
    }

    for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
      const message = sourceMessages[index];
      if (!message) {
        continue;
      }

      if ((message.kind === "thinking" || message.kind === "assistant") && message.content.trim().length > 0) {
        return message.id;
      }
    }

    return null;
  }, [props.isLoading, sourceMessages]);

  const renderedEntries = useMemo(
    () =>
      buildRenderedMessageEntries(
        sourceMessages,
        props.selectedMessageId,
        contentWidth,
        renderPolicy,
        expandedMessageIds,
        props.assistantLabel,
        props.unseenDividerMessageId,
        liveMarkdownMessageId,
        props.thinkingMessagesExpandedByDefault
      ),
    [
      contentWidth,
      expandedMessageIds,
      props.assistantLabel,
      liveMarkdownMessageId,
      sourceMessages,
      renderPolicy,
      props.selectedMessageId,
      props.unseenDividerMessageId,
      props.thinkingMessagesExpandedByDefault
    ]
  );
  const entryRowCounts = useMemo(
    () => renderedEntries.map((entry) => entry.rowCount),
    [renderedEntries]
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
  const virtualRange = useVirtualScroll({
    enabled: VIRTUAL_SCROLL_ENABLED,
    sticky: stickySnapshot,
    entryOffsets,
    entryRowCounts,
    totalRowCount,
    scrollHandleRef: scrollRef
  });

  useEffect(() => {
    const handle = scrollRef.current;
    logLayoutTrace("message-list:layout", {
      viewportWidth: props.viewportWidth,
      contentWidth,
      messages: props.messages.length,
      totalRowCount,
      sticky: stickySnapshotRef.current,
      scrollTop: handle?.getScrollTop() ?? null,
      viewportHeight: handle?.getViewportHeight() ?? null,
      scrollHeight: handle ? Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight()) : null
    });
  }, [contentWidth, props.messages.length, props.viewportWidth, totalRowCount]);

  useEffect(() => {
    const previousIds = previousMessageIdsRef.current;
    const nextIds = props.messages.map((message) => message.id);
    const prependedIds = resolvePrependedMessageIds(previousIds, nextIds);
    if (prependedIds.length > 0 && !stickySnapshotRef.current) {
      pendingPrependMessageIdsRef.current = prependedIds;
    } else {
      pendingPrependMessageIdsRef.current = [];
    }
    previousMessageIdsRef.current = nextIds;
  }, [props.messages]);

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

    scrollManuallyTo(scrollTop);
    activateScrollIndicator();
  }

  function maybeShiftSelectionForManualScroll(actualDelta: number) {
    if (actualDelta === 0) {
      return;
    }

    const state = selection.getState();
    if (!state?.anchor) {
      return;
    }

    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const viewportTop = handle.getViewportTop();
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const viewportBottom = viewportTop + viewportHeight - 1;
    const anchorInViewport =
      state.anchor.row >= viewportTop && state.anchor.row <= viewportBottom;

    if (!anchorInViewport) {
      return;
    }

    if (state.isDragging) {
      if (selection.hasSelection()) {
        if (actualDelta > 0) {
          selection.captureScrolledRows(viewportTop, viewportTop + actualDelta - 1, "above");
        } else {
          selection.captureScrolledRows(viewportBottom + actualDelta + 1, viewportBottom, "below");
        }
      }
      selection.shiftAnchor(-actualDelta, viewportTop, viewportBottom);
      return;
    }

    const focusInViewport =
      !state.focus ||
      (state.focus.row >= viewportTop && state.focus.row <= viewportBottom);

    if (!focusInViewport || !selection.hasSelection()) {
      return;
    }

    if (actualDelta > 0) {
      selection.captureScrolledRows(viewportTop, viewportTop + actualDelta - 1, "above");
    } else {
      selection.captureScrolledRows(viewportBottom + actualDelta + 1, viewportBottom, "below");
    }

    selection.shiftSelection(-actualDelta, viewportTop, viewportBottom);
  }

  function scrollManuallyBy(requestedDelta: number) {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const currentScrollTop = handle.getScrollTop();
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    const nextScrollTop = Math.max(0, Math.min(currentScrollTop + requestedDelta, maxScrollTop));
    const actualDelta = nextScrollTop - currentScrollTop;

    if (actualDelta === 0) {
      return;
    }

    maybeShiftSelectionForManualScroll(actualDelta);
    handle.scrollBy(actualDelta);
  }

  function scrollManuallyTo(targetScrollTop: number) {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const currentScrollTop = handle.getScrollTop();
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    const nextScrollTop = Math.max(0, Math.min(Math.floor(targetScrollTop), maxScrollTop));
    const actualDelta = nextScrollTop - currentScrollTop;

    if (actualDelta === 0) {
      return;
    }

    maybeShiftSelectionForManualScroll(actualDelta);
    handle.scrollTo(nextScrollTop);
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

  const handleExpandableMessageClick = useCallback(
    (message: TerminalUiMessage, event: TerminalClickEvent) => {
      if (event.cellIsBlank) {
        return;
      }

      setExpandedMessageIds((previous) => {
        const next = new Set(previous);
        const expanded = isMessageExpanded(
          message,
          previous,
          props.thinkingMessagesExpandedByDefault
        );

        if (isDefaultExpandedMessage(message, props.thinkingMessagesExpandedByDefault)) {
          if (expanded) {
            next.add(message.id);
          } else {
            next.delete(message.id);
          }
          return next;
        }

        if (expanded) {
          next.delete(message.id);
        } else {
          next.add(message.id);
        }

        return next;
      });
    },
    [props.thinkingMessagesExpandedByDefault]
  );

  useEffect(() => {
    if (thinkingDefaultExpandedRef.current === props.thinkingMessagesExpandedByDefault) {
      return;
    }

    thinkingDefaultExpandedRef.current = props.thinkingMessagesExpandedByDefault;
    setExpandedMessageIds((previous) => {
      const thinkingIds = new Set(
        sourceMessages
          .filter((message) => message.kind === "thinking")
          .map((message) => message.id)
      );
      if (thinkingIds.size === 0) {
        return previous;
      }

      const next = new Set<string>();
      let changed = false;
      for (const id of previous) {
        if (thinkingIds.has(id)) {
          changed = true;
        } else {
          next.add(id);
        }
      }

      return changed ? next : previous;
    });
  }, [props.thinkingMessagesExpandedByDefault, sourceMessages]);

  useEffect(() => {
    setExpandedMessageIds((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const validIds = new Set(
        sourceMessages
          .filter((message) =>
            message.kind === "tool" ||
            message.kind === "thinking" ||
            isContextPreviewMessage(message) ||
            isCollapsibleSystemMessage(message)
          )
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
  }, [sourceMessages]);

  useImperativeHandle(ref, () => ({
    scrollBy: (delta) => {
      scrollManuallyBy(delta);
    },
    scrollPage: (delta) => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      const pageStep = Math.max(1, handle.getViewportHeight() - 2);
      scrollManuallyBy(delta * pageStep);
    },
    scrollToTop: () => {
      scrollManuallyTo(0);
    },
    scrollToBottom: () => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      const viewportHeight = Math.max(1, handle.getViewportHeight());
      const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());
      scrollManuallyTo(Math.max(0, scrollHeight - viewportHeight));
    },
    refreshViewport: () => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      const shouldStick =
        stickySnapshotRef.current || handle.isSticky() || isHandleAtBottom(handle);
      if (shouldStick) {
        handle.scrollToBottom();
        return;
      }

      handle.scrollTo(handle.getScrollTop());
    },
    getVisibleMessageId: () =>
      visibleMessageIdRef.current ??
      props.selectedMessageId ??
      props.messages.at(-1)?.id ??
      null
  }), [props.messages, props.selectedMessageId, selection]);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const syncScrollState = () => {
      const syncStartedAtMs = SCROLL_PERF_LOG_ENABLED ? Date.now() : 0;
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

      logLayoutTrace("message-list:scroll-sync", {
        contentWidth,
        scrollTop,
        viewportHeight,
        scrollHeight,
        isAtBottom,
        effectiveSticky,
        totalRowCount
      });

      stickySnapshotRef.current = effectiveSticky;
      props.onStickyChange(effectiveSticky);
      visibleMessageIdRef.current = resolveVisibleMessageId(
        renderedEntries,
        entryOffsets,
        scrollTop
      );
      const nearTop = scrollTop <= NEAR_TOP_TRIGGER_ROWS;
      if (nearTop && !nearTopSnapshotRef.current) {
        props.onNearTop?.(visibleMessageIdRef.current);
      }
      nearTopSnapshotRef.current = nearTop;
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

      if (!SCROLL_PERF_LOG_ENABLED) {
        return;
      }

      const durationMs = Date.now() - syncStartedAtMs;
      const stats = scrollSyncPerfRef.current;
      stats.sampleCount += 1;
      stats.totalDurationMs += durationMs;
      stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);

      if (durationMs >= SCROLL_PERF_SLOW_SYNC_THRESHOLD_MS) {
        logForDebugging(
          `[scroll-perf] sync slow durationMs=${durationMs} messages=${props.messages.length} renderedEntries=${renderedEntries.length} totalRows=${totalRowCount}`,
          { level: "debug" }
        );
      } else {
        logForDebugging(`[scroll-perf] sync durationMs=${durationMs}`, { level: "verbose" });
      }

      const nowMs = Date.now();
      if (nowMs - stats.lastFlushAtMs < SCROLL_PERF_FLUSH_INTERVAL_MS) {
        return;
      }

      const averageMs = stats.sampleCount > 0
        ? Number((stats.totalDurationMs / stats.sampleCount).toFixed(2))
        : 0;
      logForDebugging(
        `[scroll-perf] sync aggregate samples=${stats.sampleCount} avgMs=${averageMs} maxMs=${stats.maxDurationMs} messages=${props.messages.length} renderedEntries=${renderedEntries.length} totalRows=${totalRowCount}`,
        { level: "debug" }
      );
      stats.sampleCount = 0;
      stats.totalDurationMs = 0;
      stats.maxDurationMs = 0;
      stats.lastFlushAtMs = nowMs;
    };

    syncScrollState();
    const timeout = setTimeout(syncScrollState, 0);
    const unsubscribe = handle.subscribe(syncScrollState);

    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [
    entryOffsets,
    props.messages.length,
    props.onNearTop,
    props.onStickyChange,
    renderedEntries,
    totalRowCount
  ]);

  useEffect(() => {
    if (!SCROLL_PERF_LOG_ENABLED) {
      return;
    }

    const nextSignature =
      `${props.messages.length}|${renderedEntries.length}|${totalRowCount}|${contentWidth}`;
    if (layoutPerfSignatureRef.current === nextSignature) {
      return;
    }

    layoutPerfSignatureRef.current = nextSignature;
    logForDebugging(
      `[scroll-perf] layout messageCount=${props.messages.length} renderedEntries=${renderedEntries.length} totalRows=${totalRowCount} contentWidth=${contentWidth}`,
      { level: "debug" }
    );
  }, [contentWidth, props.messages.length, renderedEntries.length, totalRowCount]);

  useEffect(() => {
    return () => {
      scrollDragOffsetRef.current = null;
      nearTopSnapshotRef.current = false;
      pendingPrependMessageIdsRef.current = [];
      if (scrollIndicatorTimeoutRef.current) {
        clearTimeout(scrollIndicatorTimeoutRef.current);
        scrollIndicatorTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const pendingIds = pendingPrependMessageIdsRef.current;
    if (pendingIds.length === 0) {
      return;
    }

    const rowCountById = new Map(
      renderedEntries.map((entry) => [entry.message.id, Math.max(1, entry.rowCount)] as const)
    );
    const addedRows = pendingIds.reduce(
      (sum, messageId) => sum + (rowCountById.get(messageId) ?? 0),
      0
    );
    pendingPrependMessageIdsRef.current = [];
    if (addedRows <= 0) {
      return;
    }

    scrollManuallyBy(addedRows);
  }, [renderedEntries]);

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

    logLayoutTrace("message-list:layout-change", {
      previousContentWidth: previousSignature.contentWidth,
      nextContentWidth: nextSignature.contentWidth,
      previousMessages: previousSignature.messageCount,
      nextMessages: nextSignature.messageCount,
      previousRows: previousSignature.totalRowCount,
      nextRows: nextSignature.totalRowCount,
      viewportChanged,
      contentChanged,
      sticky: stickySnapshotRef.current,
      handleSticky: handle.isSticky(),
      isAtBottom: isHandleAtBottom(handle),
      scrollTop: handle.getScrollTop(),
      viewportHeight: handle.getViewportHeight(),
      scrollHeight: Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight())
    });

    if (stickySnapshotRef.current || handle.isSticky() || isHandleAtBottom(handle)) {
      logLayoutTrace("message-list:resize-action", {
        action: "scrollToBottom",
        contentWidth,
        scrollTop: handle.getScrollTop()
      });
      handle.scrollToBottom();
      return;
    }

    if (viewportChanged) {
      // Resize after overlay close can leave ScrollBox viewport metrics one
      // frame behind. Trigger a no-op scroll mutation to force a fresh sync.
      logLayoutTrace("message-list:resize-action", {
        action: "scrollToSamePosition",
        contentWidth,
        scrollTop: handle.getScrollTop()
      });
      handle.scrollTo(handle.getScrollTop());
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
          <TranscriptRows
            renderedEntries={renderedEntries}
            virtualRange={virtualRange}
            unseenMessageCount={props.unseenMessageCount}
            onExpandableMessageClick={handleExpandableMessageClick}
          />
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
