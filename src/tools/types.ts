export type ToolPermissionKind = "command" | "file-write" | "web" | "external-directory";

export interface ExternalDirectoryApprovalScope {
  type: "external-directory";
  directory: string;
}

export type ToolApprovalScope = ExternalDirectoryApprovalScope;

export interface ToolApprovalRequest {
  kind: ToolPermissionKind;
  toolName: string;
  title: string;
  summary: string;
  details: string[];
  scope?: ToolApprovalScope;
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

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

export type FileReadStateKind =
  | "text"
  | "directory"
  | "notebook"
  | "image"
  | "pdf"
  | "binary";

export type FileReadStateSource = "read" | "write";

export interface FileReadState {
  kind: FileReadStateKind;
  source?: FileReadStateSource;
  displayPath: string;
  readAt: string;
  mtimeMs?: number;
  sizeBytes?: number;
  offset?: number;
  limit?: number;
  totalCount?: number;
  returnedCount?: number;
  isPartial: boolean;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  allowedRoots: string[];
  requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
  askUserQuestions: (
    request: AskUserQuestionRequest,
    options?: {
      signal?: AbortSignal;
    }
  ) => Promise<AskUserQuestionResponse>;
  getTodos: () => TodoItem[];
  setTodos: (todos: TodoItem[]) => void;
  commandTimeoutMs: number;
  turnId: string;
  abortSignal: AbortSignal;
  captureFileBeforeWrite: (absolutePath: string) => Promise<void>;
  recordFileRead: (absolutePath: string, state: FileReadState) => void;
  getFileReadState: (absolutePath: string) => FileReadState | undefined;
}

export type JsonRecord = Record<string, unknown>;
