import { useCallback, useMemo, useRef } from "react";
import type { BaseInputState } from "../types/textInputTypes.js";
import type { TerminalKey } from "../runtime/input.js";
import { buildInputEditorViewport, measureCharWidth, moveCursorVertically } from "../utils/text.js";
import { useDoublePress } from "./useDoublePress.js";

type UseTextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onInputKey?: (input: string, key: TerminalKey) => boolean;
  multiline?: boolean;
  columns: number;
  maxVisibleLines?: number;
  cursorOffset: number;
  onChangeCursorOffset: (offset: number) => void;
  onEscClearPendingChange?: (pending: boolean) => void;
  firstLinePrefix?: string;
  continuationPrefix?: string;
};

/** 粘贴/多行输入统一换行，去掉 \\0，避免 \\r 让光标行计算失效。 */
export function normalizeEditableText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
}

export function clampCursorOffset(value: string, cursor: number): number {
  if (!Number.isFinite(cursor) || cursor < 0) {
    return 0;
  }
  return Math.min(Math.max(0, Math.trunc(cursor)), value.length);
}

function insertText(value: string, cursor: number, text: string) {
  const safeCursor = clampCursorOffset(value, cursor);
  const normalized = normalizeEditableText(text);
  return {
    value: value.slice(0, safeCursor) + normalized + value.slice(safeCursor),
    cursor: safeCursor + normalized.length
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
  // 用 ref 挂最新 props，保持 onInput 函数身份稳定，减少 ink 输入订阅侧的同步开销。
  const propsRef = useRef(props);
  propsRef.current = props;

  const escapeDoublePress = useDoublePress(
    (pending) => {
      propsRef.current.onEscClearPendingChange?.(pending);
    },
    () => {
      const current = propsRef.current;
      if (!current.value.length) {
        return;
      }

      current.onChange("");
      current.onChangeCursorOffset(0);
    }
  );
  const safeColumns = Math.max(20, props.columns);
  const firstLinePrefix = props.firstLinePrefix ?? "> ";
  const continuationPrefix = props.continuationPrefix ?? "  ";
  const viewport = useMemo(
    () =>
      buildInputEditorViewport(
        props.value,
        props.cursorOffset,
        safeColumns,
        Math.max(1, props.maxVisibleLines ?? 4)
      ),
    [props.cursorOffset, props.maxVisibleLines, props.value, safeColumns]
  );

  const cursorLineIndex =
    props.value.length === 0 ? 0 : Math.max(0, viewport.lines.findIndex((line) => line.isCursorLine));
  const cursorLine = props.value.length === 0 ? null : viewport.lines[cursorLineIndex] ?? null;

  // 稳定 onInput 身份；实际逻辑读 propsRef，避免父组件重渲染时反复换 handler。
  const onInputImpl = (input: string, key: TerminalKey) => {
    const current = propsRef.current;
    const commit = (nextValue: string, nextCursor: number) => {
      const safeCursor = clampCursorOffset(nextValue, nextCursor);
      current.onChange(nextValue);
      current.onChangeCursorOffset(safeCursor);
    };

    if (current.onInputKey?.(input, key)) {
      return;
    }

    if (key.escape) {
      if (!current.value.length) {
        escapeDoublePress.reset();
        return;
      }

      escapeDoublePress.trigger();
      return;
    }

    escapeDoublePress.reset();

    if (key.return && !key.shift && !key.meta && !key.ctrl) {
      if (current.multiline && current.cursorOffset > 0 && current.value[current.cursorOffset - 1] === "\\") {
        const nextValue =
          current.value.slice(0, current.cursorOffset - 1) + "\n" + current.value.slice(current.cursorOffset);
        commit(nextValue, current.cursorOffset);
        return;
      }

      if (!current.value.trim()) {
        return;
      }

      current.onSubmit?.(current.value);
      return;
    }

    if (key.return && (key.shift || key.meta || key.ctrl)) {
      const next = insertText(current.value, current.cursorOffset, "\n");
      commit(next.value, next.cursor);
      return;
    }

    if (key.leftArrow) {
      current.onChangeCursorOffset(Math.max(0, current.cursorOffset - 1));
      return;
    }

    if (key.rightArrow) {
      current.onChangeCursorOffset(Math.min(current.value.length, current.cursorOffset + 1));
      return;
    }

    if (key.upArrow) {
      current.onChangeCursorOffset(moveCursorVertically(current.value, current.cursorOffset, safeColumns, -1));
      return;
    }

    if (key.downArrow) {
      current.onChangeCursorOffset(moveCursorVertically(current.value, current.cursorOffset, safeColumns, 1));
      return;
    }

    if (key.home || (key.ctrl && input.toLowerCase() === "a")) {
      current.onChangeCursorOffset(0);
      return;
    }

    if (key.end || (key.ctrl && input.toLowerCase() === "e")) {
      current.onChangeCursorOffset(current.value.length);
      return;
    }

    if (key.backspace) {
      const next = removeBeforeCursor(current.value, current.cursorOffset);
      commit(next.value, next.cursor);
      return;
    }

    if (key.delete) {
      const next = removeAtCursor(current.value, current.cursorOffset);
      commit(next.value, next.cursor);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "u") {
      commit("", 0);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "w") {
      const next = removePreviousWord(current.value, current.cursorOffset);
      commit(next.value, next.cursor);
      return;
    }

    if (key.ctrl || key.meta || key.escape || key.wheelUp || key.wheelDown || !input) {
      return;
    }

    const next = insertText(current.value, current.cursorOffset, input);
    commit(next.value, next.cursor);
  };

  const onInputImplRef = useRef(onInputImpl);
  onInputImplRef.current = onInputImpl;
  const onInput = useCallback((input: string, key: TerminalKey) => {
    onInputImplRef.current(input, key);
  }, []);

  return {
    onInput,
    lines: viewport.lines,
    cursorLine: cursorLineIndex,
    cursorColumn:
      (props.value.length === 0
        ? getDisplayWidth(firstLinePrefix)
        : getDisplayWidth(cursorLineIndex === 0 ? firstLinePrefix : continuationPrefix)) +
      getDisplayWidth(cursorLine?.before ?? ""),
    hasTopOverflow: viewport.hasTopOverflow,
    hasBottomOverflow: viewport.hasBottomOverflow
  };
}
