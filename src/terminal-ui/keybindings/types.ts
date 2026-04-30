export type KeybindingContextName = "Global" | "Conversation" | "Scroll";

export type TerminalUiAction =
  | "app:quit"
  | "app:openSettings"
  | "app:escape"
  | "conversation:previousMessage"
  | "conversation:nextMessage"
  | "scroll:lineUp"
  | "scroll:lineDown"
  | "scroll:pageUp"
  | "scroll:pageDown"
  | "scroll:top"
  | "scroll:bottom";

export interface ParsedKeystroke {
  key: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ParsedBinding {
  context: KeybindingContextName;
  action: TerminalUiAction | null;
  chord: ParsedKeystroke[];
}

export interface KeybindingBlock {
  context: KeybindingContextName;
  bindings: Record<string, TerminalUiAction | null>;
}
