import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import { buildInputViewport } from "../utils/text.js";

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
  viewportWidth: number;
  disabled: boolean;
  disabledReason?: string;
  onCtrlCCaptureChange: (capture: boolean) => void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    props.onCtrlCCaptureChange(!props.disabled && value.length > 0);
  }, [props.disabled, props.onCtrlCCaptureChange, value]);

  useEffect(() => {
    return () => {
      props.onCtrlCCaptureChange(false);
    };
  }, [props.onCtrlCCaptureChange]);

  useInput((input, key) => {
    if (props.disabled) {
      return;
    }

    const extendedKey = key as typeof key & { home?: boolean; end?: boolean };

    if (key.return) {
      const nextValue = value.trim();
      if (!nextValue) {
        return;
      }

      setValue("");
      setCursor(0);
      void props.onSubmit(nextValue);
      return;
    }

    if (key.leftArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor((current) => Math.min(value.length, current + 1));
      return;
    }

    if (extendedKey.home || (key.ctrl && input.toLowerCase() === "a")) {
      setCursor(0);
      return;
    }

    if (extendedKey.end || (key.ctrl && input.toLowerCase() === "e")) {
      setCursor(value.length);
      return;
    }

    if (key.backspace) {
      const next = removeBeforeCursor(value, cursor);
      setValue(next.value);
      setCursor(next.cursor);
      return;
    }

    if (key.delete) {
      const next = removeAtCursor(value, cursor);
      setValue(next.value);
      setCursor(next.cursor);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "c") {
      if (!value.length) {
        return;
      }

      setValue("");
      setCursor(0);
      return;
    }

    if (key.ctrl || key.meta || key.escape || !input) {
      return;
    }

    const next = insertText(value, cursor, input);
    setValue(next.value);
    setCursor(next.cursor);
  }, { isActive: !props.disabled });

  const viewport = buildInputViewport(value, cursor, Math.max(16, props.viewportWidth - 8));
  const helperText = props.disabled
    ? props.disabledReason || "Input locked."
    : "Enter submit | Ctrl+X settings | Ctrl+C clear or quit | Home/End move";

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
