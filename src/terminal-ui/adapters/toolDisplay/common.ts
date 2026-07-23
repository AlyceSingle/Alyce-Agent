import { randomUUID } from "node:crypto";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone,
  TerminalUiToolData,
  TerminalUiToolWriteResult
} from "../../state/types.js";
import { serializeMessageBlocks } from "../../utils/messageBlocks.js";
import { asRecord, asString } from "../../../core/util/unknown.js";
import {
  PROCESS_LIST_TOOL_NAME,
  PROCESS_READ_TOOL_NAME,
  PROCESS_START_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME
} from "../../../tools/BackgroundProcessTool/toolName.js";
import {
  PTY_CLOSE_TOOL_NAME,
  PTY_CREATE_TOOL_NAME,
  PTY_LIST_TOOL_NAME,
  PTY_READ_TOOL_NAME,
  PTY_RESIZE_TOOL_NAME,
  PTY_WRITE_TOOL_NAME
} from "../../../tools/PtyTool/toolName.js";

export {
  asBoolean,
  asNullableNumber,
  asNullableString,
  asNumber,
  asNumberArray,
  asRecord,
  asRecordArray,
  asString,
  asStringArray
} from "../../../core/util/unknown.js";

// 共享块构建与 unknown 解析小工具。

export const DEFAULT_PREVIEW_MAX_CHARS = 320;
export const STREAMING_MESSAGE_METADATA = "streaming";
export const TOOL_PREVIEW_MAX_CHARS = 520;
export const TOOL_TITLE_MAX_CHARS = 96;
export const TOOL_TARGET_KEYS = ["file_path", "filePath", "path", "url", "query", "pattern", "command", "cwd", "pty_id"];
export const MARKDOWN_FRIENDLY_TOOL_NAME_TOKENS = [
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "codesearch"
];
export const BACKGROUND_PROCESS_TOOL_NAMES = new Set([
  PROCESS_START_TOOL_NAME,
  PROCESS_LIST_TOOL_NAME,
  PROCESS_READ_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME
]);
export const PTY_TOOL_NAMES = new Set([
  PTY_CREATE_TOOL_NAME,
  PTY_LIST_TOOL_NAME,
  PTY_READ_TOOL_NAME,
  PTY_WRITE_TOOL_NAME,
  PTY_RESIZE_TOOL_NAME,
  PTY_CLOSE_TOOL_NAME
]);
export type ToolResultIssue = {
  path: string;
  code: string;
  message: string;
};

export type ToolResultError = {
  type?: string;
  status?: string;
  message: string;
  issues?: ToolResultIssue[];
};

export type DiagnosticsDisplayResult = NonNullable<TerminalUiToolWriteResult["diagnostics"]>;

export type ParsedToolCallExecutionResult = {
  toolName: string;
  parsedArgs?: Record<string, unknown>;
  displayResult: string;
  structuredResult: unknown;
  ok: boolean;
  status?: string;
  error?: ToolResultError;
};

export function normalizeBlockContent(content: string, preserveWhitespaceOnly = false) {
  if (content.trim().length > 0 || (preserveWhitespaceOnly && content.length > 0)) {
    return content;
  }

  return "(empty)";
}

export function truncateText(content: string, maxChars: number) {
  if (content.length <= maxChars) {
    return content;
  }

  return content.slice(0, maxChars).trimEnd() + " ...";
}

export function createBlock(
  content: string,
  options: {
    label?: string;
    tone?: TerminalUiMessageBlockTone;
    style?: TerminalUiMessageBlockStyle;
  } = {}
): TerminalUiMessageBlock {
  return {
    label: options.label,
    tone: options.tone ?? "default",
    style: options.style ?? "plain",
    content: normalizeBlockContent(content, options.style === "code")
  };
}

export function createMessage(options: {
  kind: TerminalUiMessage["kind"];
  title: string;
  blocks: TerminalUiMessageBlock[];
  metadata?: string[];
  maxPreviewChars?: number;
  toolData?: TerminalUiToolData;
}): TerminalUiMessage {
  const serializedContent = serializeMessageBlocks(options.blocks);
  const content = serializedContent.length > 0 ? serializedContent : "(empty)";
  const preview = truncateText(content, options.maxPreviewChars ?? DEFAULT_PREVIEW_MAX_CHARS);

  return {
    id: randomUUID(),
    kind: options.kind,
    title: options.title,
    blocks: options.blocks,
    content,
    preview,
    metadata: options.metadata ?? [],
    createdAt: new Date().toISOString(),
    toolData: options.toolData
  };
}

export function formatStructuredValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncateInline(value: string, maxChars: number) {
  const safeMaxChars = Math.max(16, maxChars);
  return value.length <= safeMaxChars
    ? value
    : `${value.slice(0, Math.max(0, safeMaxChars - 3)).trimEnd()}...`;
}

export function normalizeInlineValue(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function capitalizeWord(value: string) {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

export function tryParseRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? undefined;
  } catch {
    return undefined;
  }
}

export function toToolResultError(value: unknown): ToolResultError | undefined {
  const record = asRecord(value);
  const message = record ? asString(record.message) : undefined;
  if (!record || !message) {
    return undefined;
  }

  return {
    type: asString(record.type),
    status: asString(record.status),
    message,
    issues: Array.isArray(record.issues)
      ? record.issues.flatMap((issue) => {
          const issueRecord = asRecord(issue);
          const path = issueRecord ? asString(issueRecord.path) : undefined;
          const code = issueRecord ? asString(issueRecord.code) : undefined;
          const issueMessage = issueRecord ? asString(issueRecord.message) : undefined;

          if (!path || !code || !issueMessage) {
            return [];
          }

          return [{ path, code, message: issueMessage }];
        })
      : undefined
  };
}

export function formatToolError(error: ParsedToolCallExecutionResult["error"], fallback: string) {
  if (!error) {
    return fallback;
  }

  const lines = [
    ...(error.status ? [`Status: ${error.status}`] : []),
    ...(error.type ? [`Type: ${error.type}`] : []),
    error.message
  ];
  if (error.issues?.length) {
    lines.push("");
    lines.push(
      ...error.issues.map((issue) => `- ${issue.path}: ${issue.message} [${issue.code}]`)
    );
  }
  return lines.join("\n");
}