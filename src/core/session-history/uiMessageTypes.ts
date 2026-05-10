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
export type UiToolResultKind = "generic" | "shell" | "write" | "edit" | "patch" | "read";

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
  formatter?: UiToolFormatterResult;
  diagnostics?: UiToolDiagnosticsResult;
}

export type UiToolFormatterStatus = "skipped" | "unchanged" | "formatted" | "failed";

export interface UiToolFormatterResult {
  status: UiToolFormatterStatus;
  formatter?: string;
  command?: string[];
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export type UiToolDiagnosticsStatus = "skipped" | "pending" | "ok" | "issues" | "failed";

export interface UiToolDiagnosticIssue {
  filePath: string;
  line: number;
  character: number;
  severity: string;
  code: string;
  message: string;
  source?: string;
}

export interface UiToolDiagnosticsResult {
  status: UiToolDiagnosticsStatus;
  backend?: string;
  issues: UiToolDiagnosticIssue[];
  totalIssueCount: number;
  truncated: boolean;
  message?: string;
}

export interface UiToolEditResult {
  filePath: string;
  replaceAll: boolean;
  matchCount: number;
  formatter?: UiToolFormatterResult;
  diagnostics?: UiToolDiagnosticsResult;
}

export interface UiToolPatchFileResult {
  type: "add" | "update" | "delete" | "move";
  filePath: string;
  sourcePath?: string;
  bytes?: number;
  lineCount?: number;
  additions: number;
  deletions: number;
  matchStrategies: string[];
  formatter?: UiToolFormatterResult;
  diagnostics?: UiToolDiagnosticsResult;
}

export interface UiToolPatchResult {
  filePath: string;
  operationCount: number;
  additions: number;
  deletions: number;
  files: UiToolPatchFileResult[];
  formatter?: UiToolFormatterResult;
  diagnostics?: UiToolDiagnosticsResult;
}

export type UiToolReadResult =
  | UiToolReadTextResult
  | UiToolReadDirectoryResult
  | UiToolReadNotebookResult
  | UiToolReadAssetResult
  | UiToolReadUnchangedResult;

export interface UiToolReadTextResult {
  type: "text";
  filePath: string;
  startLine: number;
  numLines: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
}

export interface UiToolReadDirectoryResult {
  type: "directory";
  directoryPath: string;
  startEntry: number;
  numEntries: number;
  totalEntries: number;
  truncated: boolean;
  nextOffset?: number;
}

export interface UiToolReadNotebookResult {
  type: "notebook";
  filePath: string;
  summary: string;
  startCell: number;
  numCells: number;
  totalCells: number;
  truncated: boolean;
  nextOffset?: number;
}

export interface UiToolReadAssetResult {
  type: "image" | "pdf" | "binary";
  filePath: string;
  mediaType: string;
  sizeBytes: number;
  visualReadSupported: boolean;
  dimensions?: {
    width: number;
    height: number;
  };
}

export interface UiToolReadUnchangedResult {
  type: "file_unchanged";
  filePath: string;
  message: string;
  previousKind: "text" | "notebook";
  offset: number;
  limit?: number;
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
  patch?: UiToolPatchResult;
  read?: UiToolReadResult;
}
