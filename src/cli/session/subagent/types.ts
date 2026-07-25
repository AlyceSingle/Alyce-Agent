import type OpenAI from "openai";
import type { ConversationCompactor } from "../../../core/conversation/conversationCompactor.js";
import type { ContextBudgetService } from "../../../core/context/contextBudget.js";
import type { SessionId } from "../../../core/session-history/types.js";
import type {
  SubagentProgressEvent,
  SubagentTaskInfo
} from "../../../tools/types.js";

export type SubagentSessionMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface SubagentSession {
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  parentSessionId: SessionId;
  transcriptPath: string;
  metadataPath: string;
  outputPath: string;
  createdAt: string;
  updatedAt: string;
  status: SubagentTaskInfo["status"];
  startedAt?: string;
  completedAt?: string;
  evictAfter?: number;
  output?: string;
  error?: string;
  controller?: AbortController;
  promise?: Promise<void>;
  runToken?: string;
  isolateWorktree?: boolean;
  activeWorktreePath?: string;
  progress: SubagentProgressEvent[];
  worktreePath?: string;
  diffSummary?: string;
  hasChanges?: boolean;
  baseWorkspaceRoot?: string;
  messages: SubagentSessionMessage[];
  transcriptSyncedMessageCount: number;
  contextBudgetService: ContextBudgetService;
  conversationCompactor: ConversationCompactor;
}

export interface SubagentPromptInput {
  agentType: string;
  description: string;
  model?: string;
}
