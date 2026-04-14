import type React from "react";
import type { TerminalKey } from "../runtime/input.js";

export type RenderedInputLine = {
  before: string;
  current: string | null;
  after: string;
  isCursorLine: boolean;
};

export type BaseInputState = {
  onInput: (input: string, key: TerminalKey) => void;
  lines: RenderedInputLine[];
  cursorLine: number;
  cursorColumn: number;
  hasTopOverflow: boolean;
  hasBottomOverflow: boolean;
  viewportCharOffset: number;
  viewportCharEnd: number;
};

export type BaseTextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onExit?: () => void;
  onExitMessage?: (show: boolean, key?: string) => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  onHistoryReset?: () => void;
  onClearInput?: () => void;
  focus?: boolean;
  mask?: string;
  multiline?: boolean;
  showCursor?: boolean;
  highlightPastedText?: boolean;
  columns: number;
  maxVisibleLines?: number;
  cursorOffset: number;
  onChangeCursorOffset: (offset: number) => void;
  placeholder?: string;
  placeholderElement?: React.ReactNode;
  dimColor?: boolean;
};
