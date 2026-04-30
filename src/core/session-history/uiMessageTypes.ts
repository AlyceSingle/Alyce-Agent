export type UiMessageKind =
  | "system"
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "error";

export type UiMessageBlockTone =
  | "default"
  | "muted"
  | "info"
  | "success"
  | "warning"
  | "danger";

export type UiMessageBlockStyle = "plain" | "code";

export interface UiMessageBlock {
  label?: string;
  content: string;
  tone?: UiMessageBlockTone;
  style?: UiMessageBlockStyle;
}

export type UiToolMessagePhase = "start" | "result";
export type UiToolResultKind = "generic" | "shell" | "write" | "edit";

export interface UiToolShellResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface UiToolWriteResult {
  filePath: string;
  mode: "create" | "update";
  bytes: number;
  lineCount: number;
}

export interface UiToolEditResult {
  filePath: string;
  replaceAll: boolean;
  matchCount: number;
}

export interface UiToolData {
  phase: UiToolMessagePhase;
  toolName: string;
  summary: string;
  ok?: boolean;
  resultKind?: UiToolResultKind;
  shell?: UiToolShellResult;
  write?: UiToolWriteResult;
  edit?: UiToolEditResult;
}
