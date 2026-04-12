export interface ToolExecutionContext {
  workspaceRoot: string;
  requestApproval: (action: string) => Promise<boolean>;
  commandTimeoutMs: number;
}

export type JsonRecord = Record<string, unknown>;
