import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "../runtime/ink.js";
import { useTerminalInput } from "../runtime/input.js";
import { useDeclaredCursor } from "../runtime/useDeclaredCursor.js";
import { terminalUiTheme } from "../theme/theme.js";
import { buildInputEditorViewport, measureCharWidth, moveCursorVertically } from "../utils/text.js";

const INPUT_VIEWPORT_LINES = 1;
const PROMPT_PREFIX = "> ";
const CONTINUATION_PREFIX = "  ";

function getDisplayWidth(value: string) {
  let width = 0;
  for (const character of Array.from(value)) {
    width += measureCharWidth(character);
  }

  return width;
}

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

function removePreviousWord(value: string, cursor: number) {
  if (cursor <= 0) {
    return {
      value,
      cursor
    };
  }

  let target = cursor;
  while (target > 0 && /\s/.test(value[target - 1] ?? "")) {
    target -= 1;
  }
  while (target > 0 && !/\s/.test(value[target - 1] ?? "")) {
    target -= 1;
  }

  return {
    value: value.slice(0, target) + value.slice(cursor),
    cursor: target
  };
}

export function PromptInput(props: {
  value: string;
  viewportWidth: number;
  disabled: boolean;
  disabledReason?: string;
  sublineText?: string;
  onChange: (value: string) => void;
  onCtrlCCaptureChange: (capture: boolean) => void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [cursor, setCursor] = useState(0);
  const pendingValueRef = useRef<string | null>(null);
  const editorWidth = Math.max(20, props.viewportWidth - 10);

  useEffect(() => {
    props.onCtrlCCaptureChange(!props.disabled && props.value.length > 0);
  }, [props.disabled, props.onCtrlCCaptureChange, props.value]);

  useEffect(() => {
    return () => {
      props.onCtrlCCaptureChange(false);
    };
  }, [props.onCtrlCCaptureChange]);

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

  const viewport = useMemo(
    () => buildInputEditorViewport(props.value, cursor, editorWidth, INPUT_VIEWPORT_LINES),
    [cursor, editorWidth, props.value]
  );
  const cursorLineIndex =
    props.value.length === 0 ? 0 : Math.max(0, viewport.lines.findIndex((line) => line.isCursorLine));
  const cursorLine = props.value.length === 0
    ? null
    : viewport.lines[cursorLineIndex] ?? null;
  const cursorDeclaration = useDeclaredCursor({
    line: cursorLineIndex,
    column:
      (props.value.length === 0 ? getDisplayWidth(PROMPT_PREFIX) : getDisplayWidth(cursorLineIndex === 0 ? PROMPT_PREFIX : CONTINUATION_PREFIX)) +
      getDisplayWidth(cursorLine?.before ?? ""),
    active: !props.disabled
  });

  useTerminalInput((input, key) => {
    if (props.disabled) {
      return;
    }

    if (key.return && !key.shift && !key.meta) {
      if (!props.value.trim()) {
        return;
      }

      const nextValue = props.value;
      commitChange("", 0);
      void props.onSubmit(nextValue);
      return;
    }

    if (key.return && (key.shift || key.meta)) {
      const next = insertText(props.value, cursor, "\n");
      commitChange(next.value, next.cursor);
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

    if (key.upArrow) {
      setCursor((current) => moveCursorVertically(props.value, current, editorWidth, -1));
      return;
    }

    if (key.downArrow) {
      setCursor((current) => moveCursorVertically(props.value, current, editorWidth, 1));
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

    if (key.ctrl && input.toLowerCase() === "u") {
      commitChange("", 0);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "w") {
      const next = removePreviousWord(props.value, cursor);
      commitChange(next.value, next.cursor);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "j") {
      const next = insertText(props.value, cursor, "\n");
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

  const statusHint = props.disabled
    ? props.disabledReason || "Input locked."
    : props.sublineText;

  return (
    <Box
      borderStyle="round"
      borderColor={terminalUiTheme.colors.border}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      <Box ref={cursorDeclaration} flexDirection="column" width="100%">
        {props.value.length === 0 ? (
          <Text>
            <Text color={terminalUiTheme.colors.subtle}>{PROMPT_PREFIX}</Text>
            <Text
              color={terminalUiTheme.colors.inputCursorText}
              backgroundColor={terminalUiTheme.colors.inputCursor}
            >
              {" "}
            </Text>
            <Text color={terminalUiTheme.colors.subtle}> Ask Alyce to inspect, edit, or explain something...</Text>
          </Text>
        ) : (
          viewport.lines.map((line, index) => (
            <Text key={`input-line-${index}`}>
              <Text color={terminalUiTheme.colors.subtle}>
                {index === 0 ? PROMPT_PREFIX : CONTINUATION_PREFIX}
              </Text>
              <Text>{line.before}</Text>
              {line.isCursorLine && line.current !== null ? (
                <Text
                  color={terminalUiTheme.colors.inputCursorText}
                  backgroundColor={terminalUiTheme.colors.inputCursor}
                >
                  {line.current}
                </Text>
              ) : null}
              <Text>{line.after}</Text>
            </Text>
          ))
        )}
      </Box>
      {statusHint ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          {statusHint}
        </Text>
      ) : null}
    </Box>
  );
}
