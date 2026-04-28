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
  lines: string[];
  tone: TerminalUiMessageBlockTone;
  style: TerminalUiMessageBlockStyle;
};

type ThemeColor = Color;

type RenderedMessageEntry = {
  message: TerminalUiMessage;
  isSelected: boolean;
  headerLabel: string;
  headerTitle?: string;
  sections: RenderedSection[];
  markdownPlan?: MarkdownRenderPlan;
  metadataLine?: string;
  leadingSpacingRows: number;
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
  return blocks.map((block) => ({
    label: block.label,
    lines: wrapText(block.content, safeWidth),
    tone: block.tone ?? "default",
    style: block.style ?? "plain"
  }));
}

function buildRenderedMessageEntries(
  messages: TerminalUiMessage[],
  selectedMessageId: string | null,
  contentWidth: number,
  markdownEnabled: boolean
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
    const sectionRowCount = markdownPlan
      ? markdownPlan.rowCount
      : sections.reduce((sum, section) => {
          return sum + section.lines.length + (section.label ? 1 : 0);
        }, 0);

    return {
      message,
      isSelected,
      headerLabel: badge.label,
      headerTitle,
      sections,
      markdownPlan,
      metadataLine,
      leadingSpacingRows,
      palette,
      rowCount:
        leadingSpacingRows +
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
        props.markdownEnabled
      ),
    [contentWidth, props.markdownEnabled, props.messages, props.selectedMessageId]
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

                return (
                  <Box
                    key={entry.message.id}
                    flexDirection="column"
                    marginTop={entry.leadingSpacingRows}
                    width="100%"
                  >
                    {props.unseenDividerMessageId === entry.message.id ? (
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
                      <Text wrap="truncate-end">
                        <Text color={entry.isSelected ? terminalUiTheme.colors.accent : entry.palette.mutedColor}>
                          {entry.isSelected ? ">" : " "}
                        </Text>
                        <Text color={entry.palette.headerColor}> {entry.headerLabel}</Text>
                        {entry.headerTitle ? (
                          <Text color={entry.palette.bodyColor}> · {entry.headerTitle}</Text>
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
