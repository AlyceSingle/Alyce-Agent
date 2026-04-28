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
};

export type BaseTextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
  multiline?: boolean;
  showCursor?: boolean;
  columns: number;
  maxVisibleLines?: number;
  cursorOffset: number;
  onChangeCursorOffset: (offset: number) => void;
  onEscClearPendingChange?: (pending: boolean) => void;
  placeholder?: string;
  firstLinePrefix?: string;
  continuationPrefix?: string;
  prefixColor?: string;
  placeholderColor?: string;
  overflowHintColor?: string;
};
