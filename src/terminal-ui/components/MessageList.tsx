import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
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
  sections: RenderedSection[];
  metadataLine?: string;
  hintLine?: string;
  rowCount: number;
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
      return { label: "USER", color: terminalUiTheme.colors.user };
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
      return { label: "SYSTEM", color: terminalUiTheme.colors.system };
  }
}

function getToneColor(tone: TerminalUiMessageBlockTone, kind: TerminalUiMessage["kind"]) {
  switch (tone) {
    case "muted":
      return terminalUiTheme.colors.muted;
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
      return kind === "thinking" ? terminalUiTheme.colors.muted : terminalUiTheme.colors.chrome;
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
  contentWidth: number
): RenderedMessageEntry[] {
  return messages.map((message) => {
    const isSelected = message.id === selectedMessageId;
    const badge = getMessageBadge(message.kind);
    const sections = renderSections(
      message.blocks,
      message.kind === "tool" ? contentWidth - 2 : contentWidth
    );
    const metadataLine = message.metadata.length > 0 ? message.metadata.join(" | ") : undefined;
    const hintLine = message.isTruncated
      ? "Full output available. Press Ctrl+O to open reader."
      : undefined;
    const sectionRowCount = sections.reduce((sum, section) => {
      return sum + section.lines.length + (section.label ? 1 : 0);
    }, 0);

    return {
      message,
      isSelected,
      headerLabel: badge.label,
      headerColor: badge.color,
      sections,
      metadataLine,
      hintLine,
      rowCount: 1 + sectionRowCount + (metadataLine ? 1 : 0) + (hintLine ? 1 : 0) + 1
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
  transcriptSticky: boolean;
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  onStickyChange: (sticky: boolean) => void;
}>(function MessageList(props, ref) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const detailTargetMessageIdRef = useRef<string | null>(props.selectedMessageId);
  const contentWidth = Math.max(24, props.viewportWidth - 8);
  const renderedEntries = useMemo(
    () => buildRenderedMessageEntries(props.messages, props.selectedMessageId, contentWidth),
    [contentWidth, props.messages, props.selectedMessageId]
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
      const scrollHeight = currentHandle.getScrollHeight();
      const isAtBottom =
        scrollTop + viewportHeight >= Math.max(0, scrollHeight - SCROLL_HEADROOM_ROWS);

      props.onStickyChange(isAtBottom);
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

  return (
    <Box flexDirection="column" flexGrow={1} width="100%" overflow="hidden">
      <Text
        color={props.transcriptSticky ? terminalUiTheme.colors.subtle : terminalUiTheme.colors.warning}
        wrap="truncate-end"
      >
        {props.transcriptSticky ? "Live tail" : "Browsing history"}
        {" | "}
        {props.messages.length} {pluralizeMessages(props.messages.length)}
      </Text>
      <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1} width="100%">
        <ScrollBox
          ref={scrollRef}
          flexDirection="column"
          flexGrow={1}
          stickyScroll={props.transcriptSticky}
          width="100%"
        >
          {props.messages.length === 0 ? (
            <Box flexDirection="column" marginTop={1} width="100%">
              <Text color={terminalUiTheme.colors.muted}>No messages yet.</Text>
              <Text color={terminalUiTheme.colors.subtle}>
                Type a prompt below, or open settings before the first model request.
              </Text>
            </Box>
          ) : (
            renderedEntries.map((entry) => {
              const timestamp = new Date(entry.message.createdAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit"
              });

              return (
                <Box key={entry.message.id} flexDirection="column" marginTop={1} width="100%">
                  {props.unseenDividerMessageId === entry.message.id ? (
                    <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
                      -- {props.unseenMessageCount} new message{props.unseenMessageCount === 1 ? "" : "s"} --
                    </Text>
                  ) : null}
                  <Text
                    color={entry.isSelected ? terminalUiTheme.colors.chrome : entry.headerColor}
                    backgroundColor={entry.isSelected ? terminalUiTheme.colors.selection : undefined}
                    wrap="truncate-end"
                  >
                    {entry.isSelected ? ">" : " "}
                    {" "}
                    {entry.headerLabel}
                    {" · "}
                    {entry.message.title}
                    {" · "}
                    {timestamp}
                  </Text>
                  {entry.sections.map((section, sectionIndex) => (
                    <Box key={`${entry.message.id}-section-${sectionIndex}`} flexDirection="column" width="100%">
                      {section.label ? (
                        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
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
                              : getToneColor(section.tone, entry.message.kind)
                          }
                        >
                          {section.style === "code" ? "    " : "  "}
                          {line}
                        </Text>
                      ))}
                    </Box>
                  ))}
                  {entry.metadataLine ? (
                    <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
                      {"  "}
                      {entry.metadataLine}
                    </Text>
                  ) : null}
                  {entry.hintLine ? (
                    <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
                      {"  "}
                      {entry.hintLine}
                    </Text>
                  ) : null}
                </Box>
              );
            })
          )}
        </ScrollBox>
      </Box>
    </Box>
  );
});

export const MessageList = React.memo(MessageListImpl);
