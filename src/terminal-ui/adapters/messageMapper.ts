import { randomUUID } from "node:crypto";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone,
  TerminalUiToolData,
  TerminalUiToolEditResult,
  TerminalUiToolShellResult,
  TerminalUiToolWriteResult
} from "../state/types.js";
import { serializeMessageBlocks } from "../utils/messageBlocks.js";

const DEFAULT_PREVIEW_MAX_CHARS = 320;
const TOOL_PREVIEW_MAX_CHARS = 520;
const TOOL_TITLE_MAX_CHARS = 96;
const TOOL_TARGET_KEYS = ["file_path", "filePath", "path", "url", "query", "pattern", "command", "cwd"];
const ASSISTANT_TOOL_CALL_PLACEHOLDER = "(assistant requested a tool call)";

type ToolResultIssue = {
  path: string;
  code: string;
  message: string;
};

type ToolResultError = {
  type?: string;
  message: string;
  issues?: ToolResultIssue[];
};

type ParsedToolCallExecutionResult = {
  toolName: string;
  parsedArgs?: Record<string, unknown>;
  displayResult: string;
  structuredResult: unknown;
  ok: boolean;
  error?: ToolResultError;
};

function normalizeBlockContent(content: string, preserveWhitespaceOnly = false) {
  if (content.trim().length > 0 || (preserveWhitespaceOnly && content.length > 0)) {
    return content;
  }

  return "(empty)";
}

function truncateText(content: string, maxChars: number) {
  if (content.length <= maxChars) {
    return content;
  }

  return content.slice(0, maxChars).trimEnd() + " ...";
}

function createBlock(
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

function createMessage(options: {
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

export function createSystemMessage(content: string, title = "System") {
  return createMessage({
    kind: "system",
    title,
    blocks: [createBlock(content)]
  });
}

export function createUserMessage(content: string) {
  return createMessage({
    kind: "user",
    title: "Prompt",
    blocks: [createBlock(content)]
  });
}

export function createAssistantMessage(content: string) {
  return createMessage({
    kind: "assistant",
    title: "Response",
    blocks: [createBlock(content)]
  });
}

export function createThinkingMessage(content: string) {
  return createMessage({
    kind: "thinking",
    title: "Reasoning",
    blocks: [createBlock(content, { tone: "muted" })]
  });
}

export function createErrorMessage(content: string) {
  return createMessage({
    kind: "error",
    title: "Failure",
    blocks: [createBlock(content, { tone: "danger" })]
  });
}

export function shouldSkipThinkingContent(content: string) {
  return content.trim() === ASSISTANT_TOOL_CALL_PLACEHOLDER;
}

export function shouldKeepUiMessage(message: TerminalUiMessage) {
  if (
    message.kind === "tool" &&
    (message.toolData?.phase === "start" || message.metadata.includes("Tool call"))
  ) {
    return false;
  }

  if (message.kind === "thinking" && shouldSkipThinkingContent(message.content)) {
    return false;
  }

  return true;
}

export function createToolResultMessage(toolName: string, displayResult: string, rawArguments = "") {
  const result = parseToolCallExecutionResult(toolName, displayResult, rawArguments);
  const summary = buildToolSummary(result.toolName, result.parsedArgs, result.structuredResult);
  const toolData = buildToolResultData(result, summary);

  return createMessage({
    kind: "tool",
    title: summary,
    blocks: buildToolResultBlocks(result, toolData),
    metadata: buildToolResultMetadata(toolData),
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS,
    toolData
  });
}

function buildToolResultData(result: ParsedToolCallExecutionResult, summary: string): TerminalUiToolData {
  if (!result.ok) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: false,
      resultKind: "generic"
    };
  }

  const shell = toShellResult(result.structuredResult);
  if (shell) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "shell",
      shell
    };
  }

  const write = toWriteResult(result.structuredResult);
  if (write) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "write",
      write
    };
  }

  const edit = toEditResult(result.structuredResult);
  if (edit) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "edit",
      edit
    };
  }

  return {
    phase: "result",
    toolName: result.toolName,
    summary,
    ok: true,
    resultKind: "generic"
  };
}

function buildToolResultBlocks(
  result: ParsedToolCallExecutionResult,
  toolData: TerminalUiToolData
): TerminalUiMessageBlock[] {
  if (!toolData.ok) {
    return [createBlock(formatToolError(result.error, result.displayResult), { label: "Error", tone: "danger" })];
  }

  switch (toolData.resultKind) {
    case "shell": {
      const shell = toolData.shell;
      if (!shell) {
        break;
      }

      const blocks: TerminalUiMessageBlock[] = [
        createBlock(`$ ${shell.command}`, {
          label: "Command",
          style: "code"
        })
      ];
      if (shell.stdout.trim()) {
        blocks.push(createBlock(shell.stdout, { label: "Stdout", tone: "success", style: "code" }));
      }
      if (shell.stderr.trim()) {
        blocks.push(createBlock(shell.stderr, { label: "Stderr", tone: "warning", style: "code" }));
      }
      if (!shell.stdout.trim() && !shell.stderr.trim()) {
        blocks.push(createBlock("(no output)", { tone: "muted" }));
      }
      return blocks;
    }
    case "write": {
      const patchText = extractStructuredPatchDisplayText(result.structuredResult);
      return [
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
    }
    case "edit": {
      const edit = toolData.edit;
      if (!edit) {
        break;
      }

      const patchText = extractStructuredPatchDisplayText(result.structuredResult);
      return [
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
    }
    case "generic":
    default:
      break;
  }

  return [
    createBlock(formatStructuredValue(result.structuredResult), {
      label: "Output",
      tone: "success",
      style: "code"
    })
  ];
}

function buildToolResultMetadata(toolData: TerminalUiToolData) {
  const metadata = ["Tool result"];

  if (!toolData.ok) {
    metadata.push("Failed");
    return metadata;
  }

  if (toolData.shell) {
    metadata.push(`Exit: ${formatExitState(toolData.shell)}`);
    metadata.push(`${toolData.shell.durationMs} ms`);
    if (toolData.shell.timedOut) {
      metadata.push("Timed out");
    }
  }

  if (toolData.write) {
    metadata.push(toolData.write.mode === "create" ? "Created" : "Updated");
    metadata.push(`${toolData.write.bytes} bytes`);
    metadata.push(`${toolData.write.lineCount} lines`);
  }

  return metadata;
}

function buildToolSummary(
  toolName: string,
  parsedArguments?: Record<string, unknown>,
  structuredResult?: unknown
) {
  const toolTarget = resolveToolTarget(parsedArguments, structuredResult);
  if (!toolTarget) {
    return toolName;
  }

  return `${toolName} ${truncateInline(toolTarget, TOOL_TITLE_MAX_CHARS - toolName.length - 1)}`;
}

function resolveToolTarget(
  parsedArguments?: Record<string, unknown>,
  structuredResult?: unknown
): string | null {
  if (parsedArguments) {
    for (const key of TOOL_TARGET_KEYS) {
      const value = asString(parsedArguments[key]);
      if (value) {
        return normalizeInlineValue(value);
      }
    }
  }

  const resultRecord = asRecord(structuredResult);
  if (!resultRecord) {
    return null;
  }

  const filePath = asString(resultRecord.filePath);
  if (filePath) {
    return normalizeInlineValue(filePath);
  }

  return null;
}

function toShellResult(value: unknown): TerminalUiToolShellResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const command = asString(record.command);
  const cwd = asString(record.cwd);
  const stdout = asString(record.stdout);
  const stderr = asString(record.stderr);
  const durationMs = asNumber(record.durationMs);
  const timedOut = asBoolean(record.timedOut);

  if (!command || !cwd || stdout === undefined || stderr === undefined || durationMs === undefined || timedOut === undefined) {
    return null;
  }

  return {
    command,
    cwd,
    exitCode: asNullableNumber(record.exitCode),
    signal: asNullableString(record.signal),
    timedOut,
    stdout,
    stderr,
    durationMs
  };
}

function toWriteResult(
  value: unknown
): TerminalUiToolWriteResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const filePath = asString(record.filePath);
  const type = asString(record.type);
  const bytes = asNumber(record.bytes);
  const lineCount = asNumber(record.lineCount);

  if (!filePath || (type !== "create" && type !== "update") || bytes === undefined || lineCount === undefined) {
    return null;
  }

  return {
    filePath,
    mode: type,
    bytes,
    lineCount
  };
}

function toEditResult(value: unknown): TerminalUiToolEditResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const filePath = asString(record.filePath);
  const replaceAll = asBoolean(record.replaceAll);
  const matchCount = asNumber(record.matchCount);
  const structuredPatch = extractStructuredPatchLines(record);

  if (
    !filePath ||
    replaceAll === undefined ||
    matchCount === undefined ||
    structuredPatch.length === 0
  ) {
    return null;
  }

  return {
    filePath,
    replaceAll,
    matchCount
  };
}

function extractStructuredPatchText(value: unknown) {
  const record = asRecord(value);
  if (!record) {
    return "";
  }

  return extractStructuredPatchLines(record).join("\n");
}

function extractStructuredPatchDisplayText(value: unknown) {
  const rawPatchText = extractStructuredPatchText(value);
  if (!rawPatchText) {
    return "";
  }

  const filteredLines = rawPatchText
    .split("\n")
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("@@"));

  return filteredLines.join("\n");
}

function extractStructuredPatchLines(record: Record<string, unknown>) {
  if (!Array.isArray(record.structuredPatch)) {
    return [];
  }

  return record.structuredPatch.flatMap((item) => {
    const hunk = asRecord(item);
    if (!hunk) {
      return [];
    }

    const oldStart = asNumber(hunk.oldStart);
    const oldLines = asNumber(hunk.oldLines);
    const newStart = asNumber(hunk.newStart);
    const newLines = asNumber(hunk.newLines);
    const lines = Array.isArray(hunk.lines)
      ? hunk.lines.filter((line): line is string => typeof line === "string")
      : [];

    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    ) {
      return [];
    }

    return lines;
  });
}

function formatToolError(error: ParsedToolCallExecutionResult["error"], fallback: string) {
  if (!error) {
    return fallback;
  }

  const lines = [error.message];
  if (error.issues?.length) {
    lines.push("");
    lines.push(
      ...error.issues.map((issue) => `- ${issue.path}: ${issue.message} [${issue.code}]`)
    );
  }
  return lines.join("\n");
}

function parseToolCallExecutionResult(
  toolName: string,
  displayResult: string,
  rawArguments: string
): ParsedToolCallExecutionResult {
  const parsedArgs = tryParseRecord(rawArguments);
  const envelope = tryParseRecord(displayResult);

  if (!envelope) {
    return {
      toolName,
      parsedArgs,
      displayResult,
      structuredResult: displayResult,
      ok: true
    };
  }

  const ok = asBoolean(envelope.ok);
  if (ok === false) {
    return {
      toolName,
      parsedArgs,
      displayResult,
      structuredResult: envelope.error,
      ok: false,
      error: toToolResultError(envelope.error)
    };
  }

  return {
    toolName,
    parsedArgs,
    displayResult,
    structuredResult: envelope.result ?? envelope,
    ok: true
  };
}

function formatStructuredValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatExitState(result: TerminalUiToolShellResult) {
  if (result.exitCode !== null) {
    return String(result.exitCode);
  }

  if (result.signal) {
    return result.signal;
  }

  return result.timedOut ? "timeout" : "unknown";
}

function truncateInline(value: string, maxChars: number) {
  const safeMaxChars = Math.max(16, maxChars);
  return value.length <= safeMaxChars
    ? value
    : `${value.slice(0, Math.max(0, safeMaxChars - 3)).trimEnd()}...`;
}

function normalizeInlineValue(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function tryParseRecord(value: string): Record<string, unknown> | undefined {
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNullableNumber(value: unknown): number | null {
  return value === null ? null : asNumber(value) ?? null;
}

function asNullableString(value: unknown): string | null {
  return value === null ? null : asString(value) ?? null;
}

function toToolResultError(value: unknown): ToolResultError | undefined {
  const record = asRecord(value);
  const message = record ? asString(record.message) : undefined;
  if (!record || !message) {
    return undefined;
  }

  return {
    type: asString(record.type),
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
