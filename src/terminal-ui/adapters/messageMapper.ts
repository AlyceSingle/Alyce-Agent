import { randomUUID } from "node:crypto";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone,
  TerminalUiToolData,
  TerminalUiToolEditResult,
  TerminalUiToolReadResult,
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
  return stripAssistantToolCallPlaceholderLines(content).length === 0;
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

  const read = toReadResult(result.structuredResult);
  if (read) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "read",
      read
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
    case "read": {
      const read = toolData.read;
      if (!read) {
        break;
      }

      return buildReadResultBlocks(read, result.structuredResult);
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

  if (toolData.read) {
    metadata.push(...buildReadMetadata(toolData.read));
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

function toReadResult(value: unknown): TerminalUiToolReadResult | null {
  const record = asRecord(value);
  const type = asString(record?.type);
  if (!record || !type) {
    return null;
  }

  switch (type) {
    case "text": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const startLine = asNumber(file?.startLine);
      const numLines = asNumber(file?.numLines);
      const totalLines = asNumber(file?.totalLines);
      const truncated = asBoolean(file?.truncated);

      if (
        !filePath ||
        startLine === undefined ||
        numLines === undefined ||
        totalLines === undefined ||
        truncated === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        startLine,
        numLines,
        totalLines,
        truncated,
        nextOffset: asNumber(file?.nextOffset)
      };
    }
    case "directory": {
      const directory = asRecord(record.directory);
      const directoryPath = asString(directory?.directoryPath);
      const startEntry = asNumber(directory?.startEntry);
      const numEntries = asNumber(directory?.numEntries);
      const totalEntries = asNumber(directory?.totalEntries);
      const truncated = asBoolean(directory?.truncated);

      if (
        !directoryPath ||
        startEntry === undefined ||
        numEntries === undefined ||
        totalEntries === undefined ||
        truncated === undefined
      ) {
        return null;
      }

      return {
        type,
        directoryPath,
        startEntry,
        numEntries,
        totalEntries,
        truncated,
        nextOffset: asNumber(directory?.nextOffset)
      };
    }
    case "notebook": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const summary = asString(file?.summary);
      const startCell = asNumber(file?.startCell);
      const numCells = asNumber(file?.numCells);
      const totalCells = asNumber(file?.totalCells);
      const truncated = asBoolean(file?.truncated);

      if (
        !filePath ||
        !summary ||
        startCell === undefined ||
        numCells === undefined ||
        totalCells === undefined ||
        truncated === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        summary,
        startCell,
        numCells,
        totalCells,
        truncated,
        nextOffset: asNumber(file?.nextOffset)
      };
    }
    case "image":
    case "pdf":
    case "binary": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const mediaType = asString(file?.mediaType);
      const sizeBytes = asNumber(file?.sizeBytes);
      const visualReadSupported = asBoolean(file?.visualReadSupported);
      const dimensions = toImageDimensions(file?.dimensions);

      if (
        !filePath ||
        !mediaType ||
        sizeBytes === undefined ||
        visualReadSupported === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        mediaType,
        sizeBytes,
        visualReadSupported,
        ...(dimensions ? { dimensions } : {})
      };
    }
    case "file_unchanged": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const message = asString(file?.message);
      const previousKind = asString(file?.previousKind);
      const offset = asNumber(file?.offset);

      if (
        !filePath ||
        !message ||
        (previousKind !== "text" && previousKind !== "notebook") ||
        offset === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        message,
        previousKind,
        offset,
        limit: asNumber(file?.limit)
      };
    }
    default:
      return null;
  }
}

function toImageDimensions(value: unknown) {
  const record = asRecord(value);
  const width = asNumber(record?.width);
  const height = asNumber(record?.height);
  if (!record || width === undefined || height === undefined) {
    return undefined;
  }

  return { width, height };
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

function buildReadResultBlocks(
  read: TerminalUiToolReadResult,
  structuredResult: unknown
): TerminalUiMessageBlock[] {
  switch (read.type) {
    case "text": {
      const content = asString(asRecord(asRecord(structuredResult)?.file)?.content) ?? "(empty)";
      return [
        createBlock(content, {
          label: "Content",
          tone: "success",
          style: "code"
        })
      ];
    }
    case "directory": {
      const directory = asRecord(asRecord(structuredResult)?.directory);
      const entries = Array.isArray(directory?.entries)
        ? directory.entries.filter((entry): entry is string => typeof entry === "string")
        : [];
      const notice = asString(directory?.notice);
      const blocks: TerminalUiMessageBlock[] = [
        createBlock(entries.length > 0 ? entries.join("\n") : "(empty directory)", {
          label: "Entries",
          tone: "success",
          style: "code"
        })
      ];

      if (notice) {
        blocks.push(createBlock(notice, { label: "Note", tone: "warning" }));
      }

      return blocks;
    }
    case "notebook": {
      const file = asRecord(asRecord(structuredResult)?.file);
      const summary = asString(file?.summary) ?? read.summary;
      const notice = asString(file?.notice);
      const blocks: TerminalUiMessageBlock[] = [
        createBlock(summary, { label: "Summary", tone: "info" }),
        createBlock(formatNotebookCellsForDisplay(file?.cells), {
          label: "Cells",
          tone: "success",
          style: "code"
        })
      ];

      if (notice) {
        blocks.push(createBlock(notice, { label: "Note", tone: "warning" }));
      }

      return blocks;
    }
    case "image":
    case "pdf":
    case "binary": {
      const file = asRecord(asRecord(structuredResult)?.file);
      const message = asString(file?.message) ?? "Asset read completed.";
      const details = [
        `Path: ${read.filePath}`,
        `Type: ${capitalizeWord(read.type)}`,
        `Media: ${read.mediaType}`,
        `Size: ${formatBytes(read.sizeBytes)}`,
        ...(read.dimensions ? [`Dimensions: ${read.dimensions.width} x ${read.dimensions.height}`] : []),
        `Visual read: ${read.visualReadSupported ? "supported" : "not supported"}`
      ].join("\n");

      return [
        createBlock(message, {
          label: "Status",
          tone: read.visualReadSupported ? "success" : "warning"
        }),
        createBlock(details, { label: "Details", style: "code" })
      ];
    }
    case "file_unchanged": {
      const range = read.limit === undefined
        ? `offset ${read.offset}`
        : `offset ${read.offset}, limit ${read.limit}`;
      return [
        createBlock(read.message, { label: "Status", tone: "info" }),
        createBlock(
          [`Path: ${read.filePath}`, `Previous read type: ${read.previousKind}`, `Range: ${range}`].join("\n"),
          { label: "Details", style: "code" }
        )
      ];
    }
  }
}

function buildReadMetadata(read: TerminalUiToolReadResult) {
  switch (read.type) {
    case "text": {
      const endLine = read.numLines > 0 ? read.startLine + read.numLines - 1 : read.startLine;
      return [
        "Text",
        `Lines ${read.startLine}-${endLine}/${read.totalLines}`,
        ...(read.truncated && read.nextOffset !== undefined ? [`Next: ${read.nextOffset}`] : [])
      ];
    }
    case "directory": {
      const endEntry = read.numEntries > 0 ? read.startEntry + read.numEntries - 1 : read.startEntry;
      return [
        "Directory",
        `Entries ${read.startEntry}-${endEntry}/${read.totalEntries}`,
        ...(read.truncated && read.nextOffset !== undefined ? [`Next: ${read.nextOffset}`] : [])
      ];
    }
    case "notebook": {
      const endCell = read.numCells > 0 ? read.startCell + read.numCells - 1 : read.startCell;
      return [
        "Notebook",
        `Cells ${read.startCell}-${endCell}/${read.totalCells}`,
        ...(read.truncated && read.nextOffset !== undefined ? [`Next: ${read.nextOffset}`] : [])
      ];
    }
    case "image":
    case "pdf":
    case "binary":
      return [
        capitalizeWord(read.type),
        read.mediaType,
        formatBytes(read.sizeBytes),
        ...(read.dimensions ? [`${read.dimensions.width}x${read.dimensions.height}`] : []),
        read.visualReadSupported ? "Model attached" : "Metadata only"
      ];
    case "file_unchanged":
      return [
        "Unchanged",
        capitalizeWord(read.previousKind),
        read.limit === undefined ? `Offset ${read.offset}` : `Offset ${read.offset}, limit ${read.limit}`
      ];
  }
}

function formatNotebookCellsForDisplay(value: unknown) {
  if (!Array.isArray(value)) {
    return "(no notebook cells)";
  }

  const renderedCells = value.flatMap((cell) => {
    const record = asRecord(cell);
    const index = asNumber(record?.index);
    const cellType = asString(record?.cellType);
    const source = asString(record?.source);

    if (index === undefined || !cellType) {
      return [];
    }

    const heading =
      cellType === "code"
        ? `[${index}] code${formatNotebookExecutionSuffix(record?.executionCount)}`
        : `[${index}] ${cellType}`;
    const lines = [heading, source && source.length > 0 ? source : "(empty)"];
    const outputs = Array.isArray(record?.outputs)
      ? record.outputs.filter((output): output is string => typeof output === "string")
      : [];

    if (outputs.length > 0) {
      lines.push("", "[outputs]", outputs.join("\n\n"));
    }

    return [lines.join("\n")];
  });

  return renderedCells.length > 0 ? renderedCells.join("\n\n") : "(no notebook cells)";
}

function formatNotebookExecutionSuffix(value: unknown) {
  if (value === null) {
    return " (exec=null)";
  }

  const executionCount = asNumber(value);
  return executionCount === undefined ? "" : ` (exec=${executionCount})`;
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

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// 某些模型会把内部 tool-call 占位符单独混进 reasoning 文本里，UI 侧再兜底过滤一次。
function stripAssistantToolCallPlaceholderLines(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== ASSISTANT_TOOL_CALL_PLACEHOLDER)
    .join("\n")
    .trim();
}

function normalizeInlineValue(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function capitalizeWord(value: string) {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
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
