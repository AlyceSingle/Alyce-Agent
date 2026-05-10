export type LspRuntimeBackend = "typescript-language-service";

export type LspRuntimeOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls";

export type LspRuntimeBackendHealthStatus =
  | "ready"
  | "degraded"
  | "unavailable";

export interface LspRuntimeBackendFileSyncCapabilities {
  change: boolean;
  save: boolean;
  close: boolean;
}

export interface LspRuntimeBackendCapabilities {
  supportedOperations: LspRuntimeOperation[];
  supportsDiagnostics: boolean;
  fileSync: LspRuntimeBackendFileSyncCapabilities;
  supportedFileExtensions: string[];
}

export interface LspRuntimeBackendHealth {
  backend: LspRuntimeBackend;
  status: LspRuntimeBackendHealthStatus;
  checkedAt: string;
  message?: string;
}

export interface LspRuntimeBackendSnapshot {
  backend: LspRuntimeBackend;
  capabilities: LspRuntimeBackendCapabilities;
  health: LspRuntimeBackendHealth;
}

export interface LspRuntimeUnsupportedOperationErrorData {
  code: "lsp_unsupported_operation";
  backend: LspRuntimeBackend;
  operation: LspRuntimeOperation;
  filePath: string;
  supportedOperations: LspRuntimeOperation[];
}

export interface LspRuntimeQueryInput {
  operation: LspRuntimeOperation;
  filePath: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  line?: number;
  character?: number;
  query?: string;
  maxResults?: number;
  abortSignal?: AbortSignal;
}

export interface ResolvedLspRuntimeQueryInput extends LspRuntimeQueryInput {
  absolutePath: string;
}

export interface LspRuntimeFileInput {
  filePath: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  abortSignal?: AbortSignal;
}

export interface ResolvedLspRuntimeFileInput extends LspRuntimeFileInput {
  absolutePath: string;
}

export type LspRuntimeDiagnosticSeverity = "error" | "warning" | "suggestion" | "message";

export interface LspRuntimeDiagnosticIssue {
  filePath: string;
  line: number;
  character: number;
  severity: LspRuntimeDiagnosticSeverity;
  code: string;
  message: string;
  source?: string;
}

export interface LspRuntimeDiagnosticsResult {
  backend: LspRuntimeBackend;
  issues: LspRuntimeDiagnosticIssue[];
  totalIssueCount: number;
  truncated: boolean;
}

export interface LspRuntimeQueryPayload {
  result: string;
  resultCount?: number;
  fileCount?: number;
}

export interface LspRuntimeQueryResult extends LspRuntimeQueryPayload {
  operation: LspRuntimeOperation;
  filePath: string;
  backend: LspRuntimeBackend;
  backendCapabilities?: LspRuntimeBackendCapabilities;
  backendHealth?: LspRuntimeBackendHealth;
}

export interface LspRuntimeAdapter {
  backend: LspRuntimeBackend;
  capabilities: LspRuntimeBackendCapabilities;
  isSupportedFile(fileName: string): boolean;
  supportsOperation?(operation: LspRuntimeOperation): boolean;
  execute(input: ResolvedLspRuntimeQueryInput): LspRuntimeQueryPayload;
  getHealth?(): LspRuntimeBackendHealth;
  getDiagnostics?(input: ResolvedLspRuntimeFileInput): LspRuntimeDiagnosticsResult;
  syncFileChange?(input: ResolvedLspRuntimeFileInput): void;
  syncFileSave?(input: ResolvedLspRuntimeFileInput): void;
  syncFileClose?(input: ResolvedLspRuntimeFileInput): void;
}
