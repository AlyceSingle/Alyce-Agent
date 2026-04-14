import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "../runtime/ink.js";
import { getBindingDisplayText } from "../keybindings/shortcutDisplay.js";
import { useTerminalInput } from "../runtime/input.js";
import { terminalUiTheme } from "../theme/theme.js";
import { buildInputViewport } from "../utils/text.js";

const PREVIOUS_MESSAGE_SHORTCUT = getBindingDisplayText("conversation:previousMessage", "Conversation") ?? "Up";
const NEXT_MESSAGE_SHORTCUT = getBindingDisplayText("conversation:nextMessage", "Conversation") ?? "Down";
const PAGE_UP_SHORTCUT = getBindingDisplayText("conversation:pageUp", "Conversation") ?? "PgUp";
const PAGE_DOWN_SHORTCUT = getBindingDisplayText("conversation:pageDown", "Conversation") ?? "PgDn";
const OPEN_DETAIL_SHORTCUT = getBindingDisplayText("conversation:openDetail", "Global") ?? "Ctrl+O";
const OPEN_SETTINGS_SHORTCUT = getBindingDisplayText("app:openSettings", "Global") ?? "Ctrl+X";

// Keep a local cursor while reflecting the externally controlled draft value.
function insertText(value: string, cursor: number, text: string) {
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + text.length
  };
}

function removeBeforeCursor(value: string, cursor: number) {
  if (cursor <= 0) {
    return {
      value,
      cursor
    };
  }

  return {
    value: value.slice(0, cursor - 1) + value.slice(cursor),
    cursor: cursor - 1
  };
}

function removeAtCursor(value: string, cursor: number) {
  if (cursor >= value.length) {
    return {
      value,
      cursor
    };
  }

  return {
    value: value.slice(0, cursor) + value.slice(cursor + 1),
    cursor
  };
}

export function PromptInput(props: {
  value: string;
  viewportWidth: number;
  disabled: boolean;
  disabledReason?: string;
  onChange: (value: string) => void;
  onCtrlCCaptureChange: (capture: boolean) => void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [cursor, setCursor] = useState(0);
  const pendingValueRef = useRef<string | null>(null);

  useEffect(() => {
    props.onCtrlCCaptureChange(!props.disabled && props.value.length > 0);
  }, [props.disabled, props.onCtrlCCaptureChange, props.value]);

  useEffect(() => {
    return () => {
      props.onCtrlCCaptureChange(false);
    };
  }, [props.onCtrlCCaptureChange]);

  // Preserve the cursor for local edits, but snap to the end when the draft is replaced externally.
  useEffect(() => {
    if (pendingValueRef.current === props.value) {
      pendingValueRef.current = null;
      return;
    }

    setCursor(props.value.length);
    pendingValueRef.current = null;
  }, [props.value]);

  const commitChange = (nextValue: string, nextCursor: number) => {
    if (nextValue === props.value && nextCursor === cursor) {
      return;
    }

    pendingValueRef.current = nextValue;
    setCursor(nextCursor);
    props.onChange(nextValue);
  };

  // The prompt owns text-editing keys. Navigation across conversation history is handled globally.
  useTerminalInput((input, key) => {
    if (props.disabled) {
      return;
    }

    if (key.return) {
      const nextValue = props.value.trim();
      if (!nextValue) {
        return;
      }

      commitChange("", 0);
      void props.onSubmit(nextValue);
      return;
    }

    if (key.leftArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor((current) => Math.min(props.value.length, current + 1));
      return;
    }

    if (key.home || (key.ctrl && input.toLowerCase() === "a")) {
      setCursor(0);
      return;
    }

    if (key.end || (key.ctrl && input.toLowerCase() === "e")) {
      setCursor(props.value.length);
      return;
    }

    if (key.backspace) {
      const next = removeBeforeCursor(props.value, cursor);
      commitChange(next.value, next.cursor);
      return;
    }

    if (key.delete) {
      const next = removeAtCursor(props.value, cursor);
      commitChange(next.value, next.cursor);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "c") {
      if (!props.value.length) {
        return;
      }

      commitChange("", 0);
      return;
    }

    if (key.ctrl || key.meta || key.escape || !input) {
      return;
    }

    const next = insertText(props.value, cursor, input);
    commitChange(next.value, next.cursor);
  }, { isActive: !props.disabled });

  const viewport = buildInputViewport(props.value, cursor, Math.max(16, props.viewportWidth - 8));
  const helperText = props.disabled
    ? props.disabledReason || "Input locked."
    : `Enter submit | ${PREVIOUS_MESSAGE_SHORTCUT}/${NEXT_MESSAGE_SHORTCUT} browse | ${PAGE_UP_SHORTCUT}/${PAGE_DOWN_SHORTCUT} jump | ${OPEN_DETAIL_SHORTCUT} reader | ${OPEN_SETTINGS_SHORTCUT} settings | Ctrl+C clear`;

  return (
    <Box
      borderStyle="round"
      borderColor={props.disabled ? terminalUiTheme.colors.border : terminalUiTheme.colors.borderActive}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        {helperText}
      </Text>
      <Text>
        <Text color={terminalUiTheme.colors.subtle}>{"> "}</Text>
        {viewport.hasLeftOverflow ? (
          <Text color={terminalUiTheme.colors.subtle}>...</Text>
        ) : null}
        <Text>{viewport.before}</Text>
        {!props.disabled ? (
          <Text color="black" backgroundColor={terminalUiTheme.colors.chrome}>
            {viewport.current}
          </Text>
        ) : (
          <Text>{viewport.current}</Text>
        )}
        <Text>{viewport.after}</Text>
        {viewport.hasRightOverflow ? (
          <Text color={terminalUiTheme.colors.subtle}>...</Text>
        ) : null}
      </Text>
    </Box>
  );
}
