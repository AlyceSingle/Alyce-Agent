export type KeybindingContextName = "Global" | "Conversation";

export type TerminalUiAction =
  | "app:quit"
  | "app:openSettings"
  | "app:escape"
  | "conversation:openDetail"
  | "conversation:previousMessage"
  | "conversation:nextMessage"
  | "conversation:pageUp"
  | "conversation:pageDown"
  | "conversation:firstMessage"
  | "conversation:lastMessage";

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
