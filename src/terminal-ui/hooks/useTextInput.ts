import { useMemo } from "react";
import type { BaseInputState } from "../types/textInputTypes.js";
import type { TerminalKey } from "../runtime/input.js";
import { buildInputEditorViewport, measureCharWidth, moveCursorVertically } from "../utils/text.js";
import { useDoublePress } from "./useDoublePress.js";

type UseTextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  multiline?: boolean;
  columns: number;
  maxVisibleLines?: number;
  cursorOffset: number;
  onChangeCursorOffset: (offset: number) => void;
  onEscClearPendingChange?: (pending: boolean) => void;
};

function insertText(value: string, cursor: number, text: string) {
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + text.length
  };
}

function removeBeforeCursor(value: string, cursor: number) {
  if (cursor <= 0) {
    return { value, cursor };
  }

  return {
    value: value.slice(0, cursor - 1) + value.slice(cursor),
    cursor: cursor - 1
  };
}

function removeAtCursor(value: string, cursor: number) {
  if (cursor >= value.length) {
    return { value, cursor };
  }

  return {
    value: value.slice(0, cursor) + value.slice(cursor + 1),
    cursor
  };
}

function removePreviousWord(value: string, cursor: number) {
  if (cursor <= 0) {
    return { value, cursor };
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

function getDisplayWidth(value: string) {
  let width = 0;
  for (const character of Array.from(value)) {
    width += measureCharWidth(character);
  }
  return width;
}

export function useTextInput(props: UseTextInputProps): BaseInputState {
  const escapeDoublePress = useDoublePress(
    (pending) => {
      props.onEscClearPendingChange?.(pending);
    },
    () => {
      if (!props.value.length) {
        return;
      }

      props.onChange("");
      props.onChangeCursorOffset(0);
    }
  );
  const safeColumns = Math.max(20, props.columns);
  const viewport = useMemo(
    () =>
      buildInputEditorViewport(
        props.value,
        props.cursorOffset,
        safeColumns,
        Math.max(1, props.maxVisibleLines ?? 4)
      ),
    [props.columns, props.cursorOffset, props.maxVisibleLines, props.value, safeColumns]
  );

  const cursorLineIndex =
    props.value.length === 0 ? 0 : Math.max(0, viewport.lines.findIndex((line) => line.isCursorLine));
  const cursorLine = props.value.length === 0 ? null : viewport.lines[cursorLineIndex] ?? null;

  const onInput = (input: string, key: TerminalKey) => {
    const commit = (nextValue: string, nextCursor: number) => {
      props.onChange(nextValue);
      props.onChangeCursorOffset(nextCursor);
    };

    if (key.escape) {
      if (!props.value.length) {
        escapeDoublePress.reset();
        return;
      }

      escapeDoublePress.trigger();
      return;
    }

    escapeDoublePress.reset();

    if (key.return && !key.shift && !key.meta && !key.ctrl) {
      if (props.multiline && props.cursorOffset > 0 && props.value[props.cursorOffset - 1] === "\\") {
        const nextValue =
          props.value.slice(0, props.cursorOffset - 1) + "\n" + props.value.slice(props.cursorOffset);
        commit(nextValue, props.cursorOffset);
        return;
      }

      if (!props.value.trim()) {
        return;
      }

      props.onSubmit?.(props.value);
      return;
    }

    if (key.return && (key.shift || key.meta || key.ctrl)) {
      const next = insertText(props.value, props.cursorOffset, "\n");
      commit(next.value, next.cursor);
      return;
    }

    if (key.leftArrow) {
      props.onChangeCursorOffset(Math.max(0, props.cursorOffset - 1));
      return;
    }

    if (key.rightArrow) {
      props.onChangeCursorOffset(Math.min(props.value.length, props.cursorOffset + 1));
      return;
    }

    if (key.upArrow) {
      props.onChangeCursorOffset(moveCursorVertically(props.value, props.cursorOffset, safeColumns, -1));
      return;
    }

    if (key.downArrow) {
      props.onChangeCursorOffset(moveCursorVertically(props.value, props.cursorOffset, safeColumns, 1));
      return;
    }

    if (key.home || (key.ctrl && input.toLowerCase() === "a")) {
      props.onChangeCursorOffset(0);
      return;
    }

    if (key.end || (key.ctrl && input.toLowerCase() === "e")) {
      props.onChangeCursorOffset(props.value.length);
      return;
    }

    if (key.backspace) {
      const next = removeBeforeCursor(props.value, props.cursorOffset);
      commit(next.value, next.cursor);
      return;
    }

    if (key.delete) {
      const next = removeAtCursor(props.value, props.cursorOffset);
      commit(next.value, next.cursor);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "u") {
      commit("", 0);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "w") {
      const next = removePreviousWord(props.value, props.cursorOffset);
      commit(next.value, next.cursor);
      return;
    }

    if (key.ctrl || key.meta || key.escape || key.wheelUp || key.wheelDown || !input) {
      return;
    }

    const next = insertText(props.value, props.cursorOffset, input);
    commit(next.value, next.cursor);
  };

  return {
    onInput,
    lines: viewport.lines,
    cursorLine: cursorLineIndex,
    cursorColumn:
      (props.value.length === 0
        ? getDisplayWidth("> ")
        : getDisplayWidth(cursorLineIndex === 0 ? "> " : "  ")) +
      getDisplayWidth(cursorLine?.before ?? ""),
    hasTopOverflow: viewport.hasTopOverflow,
    hasBottomOverflow: viewport.hasBottomOverflow,
    viewportCharOffset: 0,
    viewportCharEnd: props.value.length
  };
}
