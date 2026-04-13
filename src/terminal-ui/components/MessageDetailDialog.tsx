import React, { useEffect, useMemo, useState } from "react";
import type { TerminalUiMessage } from "../state/types.js";
import { Box, Text, useInput } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import { wrapText } from "../utils/text.js";

export function MessageDetailDialog(props: {
  visible: boolean;
  message: TerminalUiMessage | null;
  viewportWidth: number;
  viewportHeight: number;
  onClose: () => void;
}) {
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    setScroll(0);
  }, [props.message?.id]);

  const lines = useMemo(() => {
    if (!props.message) {
      return [];
    }

    return wrapText(props.message.content, Math.max(24, props.viewportWidth - 8));
  }, [props.message, props.viewportWidth]);

  useInput((input, key) => {
    if (!props.visible || !props.message) {
      return;
    }

    const extendedKey = key as typeof key & { home?: boolean; end?: boolean };
    const maxScroll = Math.max(0, lines.length - Math.max(4, props.viewportHeight - 8));

    if (key.escape) {
      props.onClose();
      return;
    }

    if (key.upArrow) {
      setScroll((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setScroll((current) => Math.min(maxScroll, current + 1));
      return;
    }

    if (key.pageUp) {
      setScroll((current) => Math.max(0, current - 8));
      return;
    }

    if (key.pageDown || input === " ") {
      setScroll((current) => Math.min(maxScroll, current + 8));
      return;
    }

    if (extendedKey.home) {
      setScroll(0);
      return;
    }

    if (extendedKey.end) {
      setScroll(maxScroll);
    }
  }, { isActive: props.visible && Boolean(props.message) });

  if (!props.visible || !props.message) {
    return null;
  }

  const message = props.message;
  const visibleLineCount = Math.max(4, props.viewportHeight - 8);
  const visibleLines = lines.slice(scroll, scroll + visibleLineCount);

  return (
    <Box
      borderStyle="round"
      borderColor={terminalUiTheme.colors.borderActive}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
        {message.title}
      </Text>
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        {message.metadata.join(" | ") || "Full message"}
        {" | "}
        Esc close
      </Text>
      <Box flexDirection="column" marginTop={1} width="100%">
        {visibleLines.map((line, index) => (
          <Text key={`${message.id}-${scroll + index}`}>{line}</Text>
        ))}
      </Box>
      {lines.length > visibleLines.length ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          Lines {scroll + 1}-{scroll + visibleLines.length} of {lines.length}
        </Text>
      ) : null}
    </Box>
  );
}
