export type ToolPermissionKind = "command" | "file-write" | "web";

export interface ToolApprovalRequest {
  kind: ToolPermissionKind;
  toolName: string;
  title: string;
  summary: string;
  details: string[];
}

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestion {
  header: string;
  question: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionAnnotation {
  preview?: string;
  notes?: string;
}

export interface AskUserQuestionRequest {
  toolName: string;
  title: string;
  questions: AskUserQuestion[];
  metadata?: {
    source?: string;
  };
}

export interface AskUserQuestionResponse {
  answers: Record<string, string>;
  annotations?: Record<string, AskUserQuestionAnnotation>;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
  askUserQuestions: (
    request: AskUserQuestionRequest,
    options?: {
      signal?: AbortSignal;
    }
  ) => Promise<AskUserQuestionResponse>;
  commandTimeoutMs: number;
  turnId: string;
  abortSignal: AbortSignal;
  captureFileBeforeWrite: (absolutePath: string) => Promise<void>;
}

export type JsonRecord = Record<string, unknown>;
