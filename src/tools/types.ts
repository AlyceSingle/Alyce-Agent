import type { McpToolRuntime } from "../mcp/types.js";
import type { PermissionRequest } from "../core/permissions/permissionRules.js";

export type ToolPermissionKind =
  | "agent"
  | "command"
  | "file-read"
  | "file-write"
  | "web"
  | "external-directory"
  | "skill"
  | "mcp";

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
  permission?: PermissionRequest;
  forceAsk?: boolean;
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

export interface SubagentRunInput {
  agentType: string;
  description: string;
  prompt: string;
  taskId?: string;
  model?: string;
  maxSteps?: number;
  forkContext?: boolean;
  isolateWorktree?: boolean;
}

export interface SubagentRunResult {
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  output: string;
  worktreePath?: string;
  diffSummary?: string;
  hasChanges?: boolean;
}

export type SubagentTaskStatus = "running" | "completed" | "failed" | "stopped";

export type SubagentProgressEventType = "thinking" | "tool_start" | "tool_result" | "status";

export interface SubagentProgressEvent {
  timestamp: string;
  type: SubagentProgressEventType;
  message?: string;
  toolName?: string;
  rawArguments?: string;
  result?: string;
}

export interface SubagentTaskInfo {
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  status: SubagentTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  progress: SubagentProgressEvent[];
  worktreePath?: string;
  transcriptPath?: string;
  outputPath?: string;
  diffSummary?: string;
  hasChanges?: boolean;
}

export interface SubagentTaskLaunchResult {
  taskId: string;
  agentType: string;
  description: string;
  status: "running";
  model: string;
  maxSteps: number;
  startedAt: string;
}

export interface SubagentTaskStopResult {
  taskId: string;
  status: SubagentTaskStatus | "not_found";
  message: string;
  stopRequested?: boolean;
  task?: SubagentTaskInfo;
}

export type ShellPermissionMode = "none" | "read-only" | "any";

export interface ToolPermissionPolicy {
  allowWrite: boolean;
  allowNetwork: boolean;
  shell: ShellPermissionMode;
  allowBuildTest?: boolean;
  allowedRoots?: string[];
}

export interface SubagentDefinitionInfo {
  type: string;
  label: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  policy: ToolPermissionPolicy;
  maxSteps?: number;
  model?: string;
  source?: "built-in" | "custom";
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
  content?: string;
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
  recordToolActivity?: (toolName: string) => void;
  mcpRuntime?: McpToolRuntime;
  toolPolicy?: ToolPermissionPolicy;
  planMode?: boolean;
  commandTimeoutMs: number;
  turnId: string;
  abortSignal: AbortSignal;
  captureFileBeforeWrite: (absolutePath: string) => Promise<void>;
  recordFileRead: (absolutePath: string, state: FileReadState) => void;
  getFileReadState: (absolutePath: string) => FileReadState | undefined;
  runSubagent?: (input: SubagentRunInput) => Promise<SubagentRunResult>;
  launchSubagentTask?: (input: SubagentRunInput) => Promise<SubagentTaskLaunchResult>;
  listSubagentTasks?: () => SubagentTaskInfo[];
  getSubagentTask?: (taskId: string) => Promise<SubagentTaskInfo | undefined> | SubagentTaskInfo | undefined;
  recordSubagentTaskRetrieved?: (
    taskId: string,
    task: SubagentTaskInfo
  ) => Promise<void> | void;
  stopSubagentTask?: (taskId: string) => Promise<SubagentTaskStopResult>;
  getSubagentDefinition?: (type: string) => Promise<SubagentDefinitionInfo | undefined>;
  listSubagentDefinitions?: () => Promise<SubagentDefinitionInfo[]>;
}

export type JsonRecord = Record<string, unknown>;
