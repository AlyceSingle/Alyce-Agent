import React from "react";
import { Box, Text } from "../runtime/ink.js";
import type { TerminalUiMessage } from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { summarizeText, wrapText } from "../utils/text.js";

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

export function MessageList(props: {
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  viewportWidth: number;
}) {
  const contentWidth = Math.max(24, props.viewportWidth - 12);

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
      {props.messages.length === 0 ? (
        <Text color={terminalUiTheme.colors.muted}>No messages yet.</Text>
      ) : (
        props.messages.map((message) => {
          const isSelected = message.id === props.selectedMessageId;
          const lines = isSelected
            ? wrapText(message.content, contentWidth)
            : summarizeText(message.preview, contentWidth, 3);

          return (
            <Box key={message.id} flexDirection="column" marginTop={1} width="100%">
              <Text
                color={isSelected ? terminalUiTheme.colors.chrome : getMessageColor(message.kind)}
                backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isSelected ? "> " : "  "}
                {message.title}
                {" | "}
                {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit"
                })}
                {message.isTruncated && !isSelected ? " | preview" : ""}
              </Text>
              {lines.map((line, index) => (
                <Text key={`${message.id}-${index}`} color={terminalUiTheme.colors.muted}>
                  {isSelected ? "  " : "   "}
                  {line}
                </Text>
              ))}
              {message.metadata.length > 0 ? (
                <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
                  {isSelected ? "  " : "   "}
                  {message.metadata.join(" | ")}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}
