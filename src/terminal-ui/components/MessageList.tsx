import React, { useMemo } from "react";
import { getBindingDisplayText } from "../keybindings/shortcutDisplay.js";
import { Box, Text } from "../runtime/ink.js";
import type { TerminalUiMessage } from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { summarizeText, wrapTextClamped } from "../utils/text.js";

const BOX_OVERHEAD_ROWS = 3;
const MESSAGE_GAP_ROWS = 1;
const PREVIEW_MAX_LINES = 3;
const MIN_SELECTED_LINES = 6;
const MAX_SELECTED_LINES = 18;
const MIN_MESSAGE_ROWS = 6;
const PREVIOUS_MESSAGE_SHORTCUT = getBindingDisplayText("conversation:previousMessage", "Conversation") ?? "Up";
const NEXT_MESSAGE_SHORTCUT = getBindingDisplayText("conversation:nextMessage", "Conversation") ?? "Down";
const PAGE_UP_SHORTCUT = getBindingDisplayText("conversation:pageUp", "Conversation") ?? "PgUp";
const PAGE_DOWN_SHORTCUT = getBindingDisplayText("conversation:pageDown", "Conversation") ?? "PgDn";
const OPEN_DETAIL_SHORTCUT = getBindingDisplayText("conversation:openDetail", "Global") ?? "Ctrl+O";

interface RenderedMessageEntry {
  message: TerminalUiMessage;
  isSelected: boolean;
  lines: string[];
  metadataLine?: string;
  hintLine?: string;
  rowCount: number;
}

function getMessageColor(kind: TerminalUiMessage["kind"]) {
  switch (kind) {
    case "user":
      return terminalUiTheme.colors.user;
    case "assistant":
      return terminalUiTheme.colors.assistant;
    case "thinking":
      return terminalUiTheme.colors.thinking;
    case "tool":
      return terminalUiTheme.colors.tool;
    case "error":
      return terminalUiTheme.colors.danger;
    case "system":
    default:
      return terminalUiTheme.colors.system;
  }
}

function pluralizeMessages(count: number) {
  return count === 1 ? "message" : "messages";
}

function buildRenderedMessageEntries(
  messages: TerminalUiMessage[],
  selectedMessageId: string | null,
  contentWidth: number,
  viewportHeight: number
): RenderedMessageEntry[] {
  const selectedLineBudget = Math.max(
    MIN_SELECTED_LINES,
    Math.min(MAX_SELECTED_LINES, viewportHeight - 8)
  );

  return messages.map((message) => {
    const isSelected = message.id === selectedMessageId;
    const metadataLine = message.metadata.length > 0 ? message.metadata.join(" | ") : undefined;

    if (isSelected) {
      const wrapped = wrapTextClamped(message.content, contentWidth, selectedLineBudget);
      const hintLine = wrapped.truncated
        ? `Full message hidden in list view. Press ${OPEN_DETAIL_SHORTCUT} to open reader.`
        : undefined;

      return {
        message,
        isSelected,
        lines: wrapped.lines,
        metadataLine,
        hintLine,
        rowCount:
          MESSAGE_GAP_ROWS +
          1 +
          wrapped.lines.length +
          (metadataLine ? 1 : 0) +
          (hintLine ? 1 : 0)
      };
    }

    const lines = summarizeText(message.preview, contentWidth, PREVIEW_MAX_LINES);
    return {
      message,
      isSelected: false,
      lines,
      metadataLine,
      rowCount: MESSAGE_GAP_ROWS + 1 + lines.length + (metadataLine ? 1 : 0)
    };
  });
}

function computeVisibleWindow(
  entries: RenderedMessageEntry[],
  viewportHeight: number,
  scrollOffset: number
) {
  if (entries.length === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topHiddenCount: 0,
      bottomHiddenCount: 0
    };
  }

  const availableRows = Math.max(MIN_MESSAGE_ROWS, viewportHeight - BOX_OVERHEAD_ROWS);
  const bottomHiddenCount = Math.min(Math.max(0, scrollOffset), Math.max(0, entries.length - 1));
  const endIndex = Math.max(1, entries.length - bottomHiddenCount);
  const reservedBottomRows = bottomHiddenCount > 0 ? 1 : 0;
  const rowBudget = Math.max(1, availableRows - reservedBottomRows);

  let startIndex = endIndex - 1;
  let rowsUsed = entries[startIndex]?.rowCount ?? 0;

  while (startIndex > 0) {
    const nextRows = entries[startIndex - 1]?.rowCount ?? 0;
    if (rowsUsed + nextRows > rowBudget) {
      break;
    }

    startIndex -= 1;
    rowsUsed += nextRows;
  }

  while (startIndex < endIndex - 1 && startIndex > 0 && rowsUsed + 1 > rowBudget) {
    rowsUsed -= entries[startIndex]?.rowCount ?? 0;
    startIndex += 1;
  }

  return {
    startIndex,
    endIndex,
    topHiddenCount: startIndex,
    bottomHiddenCount
  };
}

function MessageListImpl(props: {
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  viewportWidth: number;
  viewportHeight: number;
  scrollOffset: number;
}) {
  const contentWidth = Math.max(24, props.viewportWidth - 12);
  const renderedEntries = useMemo(
    () =>
      buildRenderedMessageEntries(
        props.messages,
        props.selectedMessageId,
        contentWidth,
        props.viewportHeight
      ),
    [contentWidth, props.messages, props.selectedMessageId, props.viewportHeight]
  );
  const visibleWindow = useMemo(
    () => computeVisibleWindow(renderedEntries, props.viewportHeight, props.scrollOffset),
    [props.scrollOffset, props.viewportHeight, renderedEntries]
  );
  const visibleEntries = renderedEntries.slice(visibleWindow.startIndex, visibleWindow.endIndex);

  return (
    <Box
      borderStyle="round"
      borderColor={terminalUiTheme.colors.border}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
        Conversation | {props.messages.length} messages
      </Text>
      {visibleWindow.topHiddenCount > 0 ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          Older hidden: {visibleWindow.topHiddenCount} {pluralizeMessages(visibleWindow.topHiddenCount)}
          {" | "}
          {PREVIOUS_MESSAGE_SHORTCUT}/{PAGE_UP_SHORTCUT} older
        </Text>
      ) : null}
      {props.messages.length === 0 ? (
        <Text color={terminalUiTheme.colors.muted}>No messages yet.</Text>
      ) : (
        visibleEntries.map((entry) => {
          const message = entry.message;
          return (
            <Box key={message.id} flexDirection="column" marginTop={1} width="100%">
              <Text
                color={entry.isSelected ? terminalUiTheme.colors.chrome : getMessageColor(message.kind)}
                backgroundColor={entry.isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {entry.isSelected ? "> " : "  "}
                {message.title}
                {" | "}
                {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit"
                })}
                {message.isTruncated && !entry.isSelected ? " | preview" : ""}
              </Text>
              {entry.lines.map((line, index) => (
                <Text key={`${message.id}-${index}`} color={terminalUiTheme.colors.muted}>
                  {entry.isSelected ? "  " : "   "}
                  {line}
                </Text>
              ))}
              {entry.metadataLine ? (
                <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
                  {entry.isSelected ? "  " : "   "}
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
      {visibleWindow.bottomHiddenCount > 0 ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          Newer hidden: {visibleWindow.bottomHiddenCount} {pluralizeMessages(visibleWindow.bottomHiddenCount)}
          {" | "}
          {NEXT_MESSAGE_SHORTCUT}/{PAGE_DOWN_SHORTCUT} newer
        </Text>
      ) : null}
    </Box>
  );
}

export const MessageList = React.memo(
  MessageListImpl,
  (previousProps, nextProps) =>
    previousProps.messages === nextProps.messages &&
    previousProps.selectedMessageId === nextProps.selectedMessageId &&
    previousProps.viewportWidth === nextProps.viewportWidth &&
    previousProps.viewportHeight === nextProps.viewportHeight &&
    previousProps.scrollOffset === nextProps.scrollOffset
);
