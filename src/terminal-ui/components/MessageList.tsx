import React, { useEffect, useMemo, useRef } from "react";
import { getBindingDisplayText } from "../keybindings/shortcutDisplay.js";
import { Box, ScrollBox, Text, type ScrollBoxHandle } from "../runtime/ink.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone
} from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { wrapText } from "../utils/text.js";

const MESSAGE_GAP_ROWS = 1;
const SCROLL_HEADROOM_ROWS = 2;
const PREVIOUS_MESSAGE_SHORTCUT =
  getBindingDisplayText("conversation:previousMessage", "Conversation") ?? "Up";
const NEXT_MESSAGE_SHORTCUT =
  getBindingDisplayText("conversation:nextMessage", "Conversation") ?? "Down";
const PAGE_UP_SHORTCUT = getBindingDisplayText("conversation:pageUp", "Conversation") ?? "PgUp";
const PAGE_DOWN_SHORTCUT =
  getBindingDisplayText("conversation:pageDown", "Conversation") ?? "PgDn";
const OPEN_DETAIL_SHORTCUT = getBindingDisplayText("conversation:openDetail", "Global") ?? "Ctrl+O";

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

function pluralizeMessages(count: number) {
  return count === 1 ? "message" : "messages";
}

function getMessageBadge(kind: TerminalUiMessage["kind"]) {
  switch (kind) {
    case "user":
      return {
        label: "USER",
        color: terminalUiTheme.colors.user
      };
    case "assistant":
      return {
        label: "ALYCE",
        color: terminalUiTheme.colors.assistant
      };
    case "thinking":
      return {
        label: "THINK",
        color: terminalUiTheme.colors.thinking
      };
    case "tool":
      return {
        label: "TOOL",
        color: terminalUiTheme.colors.tool
      };
    case "error":
      return {
        label: "ERROR",
        color: terminalUiTheme.colors.danger
      };
    case "system":
    default:
      return {
        label: "SYSTEM",
        color: terminalUiTheme.colors.system
      };
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
  const sections: RenderedSection[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;

    sections.push({
      label: block.label,
      lines: wrapText(block.content, safeWidth),
      tone: block.tone ?? "default",
      style: block.style ?? "plain"
    });
  }

  return sections;
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
      ? `Full output available. Press ${OPEN_DETAIL_SHORTCUT} to open reader.`
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
      rowCount:
        MESSAGE_GAP_ROWS +
        1 +
        sectionRowCount +
        (metadataLine ? 1 : 0) +
        (hintLine ? 1 : 0)
    };
  });
}

function MessageListImpl(props: {
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  viewportWidth: number;
  viewportHeight: number;
  autoFollow: boolean;
}) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const contentWidth = Math.max(24, props.viewportWidth - 14);
  const renderedEntries = useMemo(
    () => buildRenderedMessageEntries(props.messages, props.selectedMessageId, contentWidth),
    [contentWidth, props.messages, props.selectedMessageId]
  );
  const entryOffsets = useMemo(
    () => {
      let offset = 0;
      return renderedEntries.map((entry) => {
        const top = offset;
        offset += entry.rowCount;
        return top;
      });
    },
    [renderedEntries]
  );
  const selectedIndex = props.messages.findIndex((message) => message.id === props.selectedMessageId);
  const followState =
    props.autoFollow || (selectedIndex >= 0 && selectedIndex === props.messages.length - 1)
      ? "Live tail"
      : "Browsing history";

  useEffect(() => {
    const applyScroll = () => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      if (props.autoFollow || selectedIndex === props.messages.length - 1) {
        handle.scrollToBottom();
        return;
      }

      if (selectedIndex < 0) {
        return;
      }

      const top = Math.max(0, (entryOffsets[selectedIndex] ?? 0) - SCROLL_HEADROOM_ROWS);
      handle.scrollTo(top);
    };

    applyScroll();
    const timeout = setTimeout(applyScroll, 0);
    return () => {
      clearTimeout(timeout);
    };
  }, [entryOffsets, props.autoFollow, props.messages.length, selectedIndex]);

  return (
    <Box
      borderStyle="round"
      borderColor={terminalUiTheme.colors.border}
      paddingX={1}
      flexDirection="column"
      height={Math.max(10, props.viewportHeight)}
      width="100%"
    >
      <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
        Conversation | {props.messages.length} {pluralizeMessages(props.messages.length)} | {followState}
      </Text>
      <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
        {PREVIOUS_MESSAGE_SHORTCUT}/{NEXT_MESSAGE_SHORTCUT} move | {PAGE_UP_SHORTCUT}/{PAGE_DOWN_SHORTCUT} jump | {OPEN_DETAIL_SHORTCUT} reader
      </Text>
      <Box marginTop={1} flexDirection="column" flexGrow={1} width="100%">
        <ScrollBox
          ref={scrollRef}
          flexDirection="column"
          flexGrow={1}
          stickyScroll={props.autoFollow}
          width="100%"
        >
          {props.messages.length === 0 ? (
            <Text color={terminalUiTheme.colors.muted}>No messages yet.</Text>
          ) : (
            renderedEntries.map((entry) => {
              const timestamp = new Date(entry.message.createdAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit"
              });

              return (
                <Box key={entry.message.id} flexDirection="column" marginTop={1} width="100%">
                  <Text
                    color={entry.isSelected ? terminalUiTheme.colors.chrome : entry.headerColor}
                    backgroundColor={entry.isSelected ? terminalUiTheme.colors.selection : undefined}
                    wrap="truncate-end"
                  >
                    {entry.isSelected ? "> " : "  "}
                    [{entry.headerLabel}] {entry.message.title}
                    {" | "}
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
}

export const MessageList = React.memo(
  MessageListImpl,
  (previousProps, nextProps) =>
    previousProps.messages === nextProps.messages &&
    previousProps.selectedMessageId === nextProps.selectedMessageId &&
    previousProps.viewportWidth === nextProps.viewportWidth &&
    previousProps.viewportHeight === nextProps.viewportHeight &&
    previousProps.autoFollow === nextProps.autoFollow
);
