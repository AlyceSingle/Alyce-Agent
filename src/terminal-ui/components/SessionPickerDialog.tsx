import { useEffect, useState } from "react";
import type { SessionHistoryListItem } from "../../core/session-history/types.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { Box, Text, useInput } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import { Pane } from "./Pane.js";

const VISIBLE_COUNT = 8;

export function SessionPickerDialog(props: {
  sessions: SessionHistoryListItem[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useRegisterOverlay("session-picker", props.sessions.length > 0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.sessions]);

  useInput((input, key) => {
    if (props.sessions.length === 0) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(props.sessions.length - 1, current + 1));
      return;
    }

    if (key.return) {
      const selected = props.sessions[selectedIndex];
      if (selected) {
        props.onSelect(selected.sessionId);
      }
      return;
    }

    if (key.escape) {
      props.onCancel();
      return;
    }

    if (input.toLowerCase() === "r") {
      const selected = props.sessions[selectedIndex];
      if (selected) {
        props.onSelect(selected.sessionId);
      }
    }
  }, { isActive: props.sessions.length > 0 });

  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(VISIBLE_COUNT / 2), props.sessions.length - VISIBLE_COUNT)
  );
  const visibleSessions = props.sessions.slice(startIndex, startIndex + VISIBLE_COUNT);

  return (
    <Pane
      title="Resume Session"
      subtitle={`${props.sessions.length} saved project session${props.sessions.length === 1 ? "" : "s"}`}
      accentColor={terminalUiTheme.colors.info}
      footer="↑/↓ choose | Enter resume | Esc cancel"
    >
      <Box flexDirection="column" width="100%">
        {visibleSessions.map((session, index) => {
          const actualIndex = startIndex + index;
          const isSelected = actualIndex === selectedIndex;
          const updatedAt = formatSessionTime(session.updatedAt);
          const idLabel = session.sessionId.slice(0, 8);

          return (
            <Box key={session.sessionId} flexDirection="column" width="100%">
              <Text
                color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isSelected ? ">" : " "}
                {" "}
                {session.title || "(session)"}
              </Text>
              <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
                {"  "}
                {idLabel} | {updatedAt} | {session.messageCount} messages
              </Text>
            </Box>
          );
        })}
      </Box>
    </Pane>
  );
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
