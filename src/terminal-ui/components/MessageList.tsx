import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  buildMarkdownRenderPlan,
  MarkdownRenderer,
  shouldRenderMarkdownMessage,
  type MarkdownRenderPlan
} from "./MarkdownRenderer.js";
import { Box, ScrollBox, Text, type ScrollBoxHandle } from "../runtime/ink.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone
} from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { wrapText } from "../utils/text.js";

const SCROLL_HEADROOM_ROWS = 2;

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

type RenderedMessageEntry = {
  message: TerminalUiMessage;
  isSelected: boolean;
  headerLabel: string;
  headerColor: string;
  headerTitle?: string;
  sections: RenderedSection[];
  markdownPlan?: MarkdownRenderPlan;
  metadataLine?: string;
  leadingSpacingRows: number;
  palette: MessagePalette;
  rowCount: number;
};

type MessagePalette = {
  headerColor: string;
  bodyColor: string;
  mutedColor: string;
};

export type MessageListHandle = {
  scrollBy: (delta: number) => void;
  scrollPage: (delta: -1 | 1) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  getDetailTargetMessageId: () => string | null;
};

function pluralizeMessages(count: number) {
  return count === 1 ? "message" : "messages";
}

function getMessageBadge(kind: TerminalUiMessage["kind"]) {
  switch (kind) {
    case "user":
      return { label: "USER", color: terminalUiTheme.colors.code };
    case "assistant":
      return { label: "ALYCE", color: terminalUiTheme.colors.assistant };
    case "thinking":
      return { label: "THINK", color: terminalUiTheme.colors.thinking };
    case "tool":
      return { label: "TOOL", color: terminalUiTheme.colors.tool };
    case "error":
      return { label: "ERROR", color: terminalUiTheme.colors.danger };
    case "system":
    default:
      return { label: "SYSTEM", color: terminalUiTheme.colors.code };
  }
}

function getMessagePalette(
  kind: TerminalUiMessage["kind"],
  isSelected: boolean
): MessagePalette {
  if (isSelected) {
    return {
      headerColor:
        kind === "user" || kind === "system"
          ? terminalUiTheme.colors.code
          : terminalUiTheme.colors.chrome,
      bodyColor:
        kind === "system"
          ? terminalUiTheme.colors.code
          : terminalUiTheme.colors.messageCardText,
      mutedColor: terminalUiTheme.colors.muted
    };
  }

  switch (kind) {
    case "user":
      return {
        headerColor: terminalUiTheme.colors.code,
        bodyColor: terminalUiTheme.colors.messageCardText,
        mutedColor: terminalUiTheme.colors.muted
      };
    case "assistant":
      return {
        headerColor: terminalUiTheme.colors.assistant,
        bodyColor: terminalUiTheme.colors.messageCardText,
        mutedColor: terminalUiTheme.colors.muted
      };
    case "thinking":
      return {
        headerColor: terminalUiTheme.colors.thinking,
        bodyColor: terminalUiTheme.colors.messageCardMuted,
        mutedColor: terminalUiTheme.colors.subtle
      };
    case "tool":
      return {
        headerColor: terminalUiTheme.colors.tool,
        bodyColor: terminalUiTheme.colors.messageCardText,
        mutedColor: terminalUiTheme.colors.muted
      };
    case "error":
      return {
        headerColor: terminalUiTheme.colors.danger,
        bodyColor: terminalUiTheme.colors.messageCardText,
        mutedColor: terminalUiTheme.colors.muted
      };
    case "system":
    default:
      return {
        headerColor: terminalUiTheme.colors.code,
        bodyColor: terminalUiTheme.colors.code,
        mutedColor: terminalUiTheme.colors.muted
      };
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
    const bodyWidth = Math.max(16, contentWidth - 2);
    const markdownPlan = shouldRenderMarkdownMessage(message.kind, markdownEnabled)
      ? buildMarkdownRenderPlan(message.content, bodyWidth)
      : undefined;
    const sections = markdownPlan
      ? []
      : renderSections(message.blocks, message.kind === "tool" ? contentWidth - 2 : contentWidth);
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
      headerColor: badge.color,
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
  const detailTargetMessageIdRef = useRef<string | null>(props.selectedMessageId);
  const selectedMessageSnapshotRef = useRef<string | null>(props.selectedMessageId);
  const stickySnapshotRef = useRef(true);
  const layoutSignatureRef = useRef<{
    contentWidth: number;
    messageCount: number;
    totalRowCount: number;
  } | null>(null);
  const contentWidth = Math.max(24, props.viewportWidth - 8);
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
      <Box flexShrink={0} width="100%">
        <Text
          color={terminalUiTheme.colors.subtle}
          wrap="truncate-end"
        >
          {props.messages.length} {pluralizeMessages(props.messages.length)}
        </Text>
      </Box>
      <Box
        flexDirection="column"
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
          // Keep the host sticky attribute stable. Manual scrollBy/scrollTo
          // already sets the imperative sticky flag to false, so toggling the
          // prop here only risks remount/reset churn when leaving the bottom.
          stickyScroll
          width="100%"
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
                  <Text
                    color={entry.palette.headerColor}
                    wrap="truncate-end"
                  >
                    {entry.isSelected ? ">" : " "}
                    {" "}
                    {entry.headerLabel}
                    {entry.headerTitle ? (
                      <>
                        {" · "}
                        {entry.headerTitle}
                      </>
                    ) : null}
                    {" · "}
                    {timestamp}
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
                            {"  "}
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
                            {section.style === "code" ? "    " : "  "}
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
                      {"  "}
                      {entry.metadataLine}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
            </Box>
          )}
        </ScrollBox>
      </Box>
    </Box>
  );
});

export const MessageList = React.memo(MessageListImpl);
