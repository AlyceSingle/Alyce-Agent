import { randomUUID } from "node:crypto";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone,
  TerminalUiToolData,
  TerminalUiToolEditResult,
  TerminalUiToolPatchResult,
  TerminalUiToolReadResult,
  TerminalUiToolShellResult,
  TerminalUiToolWriteResult
} from "../state/types.js";
import {
  advanceDiffPatchHunkTracker,
  countDiffPatchFileHeaders,
  createDiffPatchHunkTracker,
  isInsideDiffPatchHunk,
  parseDiffPatchHunkHeader,
  setDiffPatchHunkTracker
} from "../utils/diffPatchParsing.js";
import { serializeMessageBlocks } from "../utils/messageBlocks.js";
import type { LspDiagnosticCompletedEvent } from "../../services/lsp/LspDiagnosticRegistry.js";

const DEFAULT_PREVIEW_MAX_CHARS = 320;
/** 流式输出中的消息标记：MessageList 以此跳过昂贵 markdown 重解析。 */
export const STREAMING_MESSAGE_METADATA = "streaming";
const TOOL_PREVIEW_MAX_CHARS = 520;
const TOOL_TITLE_MAX_CHARS = 96;
const TOOL_TARGET_KEYS = ["file_path", "filePath", "path", "url", "query", "pattern", "command", "cwd", "pty_id"];
const MARKDOWN_FRIENDLY_TOOL_NAME_TOKENS = [
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "codesearch"
];
const BACKGROUND_PROCESS_TOOL_NAMES = new Set([
  "ProcessStart",
  "ProcessList",
  "ProcessRead",
  "ProcessStop"
]);
const PTY_TOOL_NAMES = new Set([
  "PtyCreate",
  "PtyList",
  "PtyRead",
  "PtyWrite",
  "PtyResize",
  "PtyClose"
]);
type ToolResultIssue = {
  path: string;
  code: string;
  message: string;
};

type ToolResultError = {
  type?: string;
  status?: string;
  message: string;
  issues?: ToolResultIssue[];
};

type DiagnosticsDisplayResult = NonNullable<TerminalUiToolWriteResult["diagnostics"]>;

type ParsedToolCallExecutionResult = {
  toolName: string;
  parsedArgs?: Record<string, unknown>;
  displayResult: string;
  structuredResult: unknown;
  ok: boolean;
  status?: string;
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

export function createAssistantMessage(
  content: string,
  options?: {
    id?: string;
    createdAt?: string;
    streaming?: boolean;
  }
) {
  const message = createMessage({
    kind: "assistant",
    title: "Response",
    blocks: [createBlock(content)],
    metadata: options?.streaming ? [STREAMING_MESSAGE_METADATA] : undefined
  });
  if (options?.id) {
    message.id = options.id;
  }
  if (options?.createdAt) {
    message.createdAt = options.createdAt;
  }
  return message;
}

export function isStreamingUiMessage(message: Pick<TerminalUiMessage, "metadata">): boolean {
  return message.metadata.includes(STREAMING_MESSAGE_METADATA);
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

export function createDiagnosticsFollowUpMessage(event: LspDiagnosticCompletedEvent) {
  const diagnostics = toDiagnosticsDisplayResult(event);

  return createMessage({
    kind: "system",
    title: `Diagnostics ${truncateInline(event.filePath, TOOL_TITLE_MAX_CHARS - "Diagnostics ".length)}`,
    blocks: [
      createBlock(formatDiagnosticsFollowUpSummary(event), {
        label: "Summary",
        tone: diagnosticsTone(diagnostics.status),
        style: "code"
      }),
      createBlock(formatDiagnosticsResult(diagnostics), {
        label: "Diagnostics",
        tone: diagnosticsTone(diagnostics.status),
        style: "code"
      })
    ],
    metadata: [
      "Diagnostics follow-up",
      "Background",
      formatDiagnosticsMetadata(diagnostics),
      `Reason: ${event.completionReason}`,
      ...(event.duplicateIssueCount > 0 ? [`Deduped: ${event.duplicateIssueCount}`] : []),
      ...(event.omittedIssueCount > 0 ? [`Omitted: ${event.omittedIssueCount}`] : []),
      ...(event.groupedFileCount > 1 ? [`Files: ${event.groupedFileCount}`] : []),
      ...(event.circuitBreakerOpen
        ? [event.circuitBreakerOpenUntil
          ? `Circuit: open until ${event.circuitBreakerOpenUntil}`
          : "Circuit: open"]
        : []),
      `${event.durationMs} ms`
    ],
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS
  });
}

export function formatDiagnosticsFollowUpForModel(event: LspDiagnosticCompletedEvent) {
  const diagnostics = toDiagnosticsDisplayResult(event);
  return [
    "# Background Diagnostics Completed",
    formatDiagnosticsFollowUpSummary(event),
    "",
    "Diagnostics:",
    formatDiagnosticsResult(diagnostics)
  ].join("\n");
}

export function shouldSkipThinkingContent(content: string) {
  return content.trim().length === 0;
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

export function isEphemeralProgressMessage(message: TerminalUiMessage) {
  if (message.kind === "system" && message.title.trim().toLowerCase() === "progress") {
    return true;
  }

  return message.metadata.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === "progress" || normalized.startsWith("progress:");
  });
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

  const patch = toPatchResult(result.structuredResult);
  if (patch) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "patch",
      patch
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
      const blocks = [
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
      blocks.push(...buildPostWriteCheckBlocks(toolData.write));
      return blocks;
    }
    case "edit": {
      const edit = toolData.edit;
      if (!edit) {
        break;
      }

      const patchText = extractStructuredPatchDisplayText(result.structuredResult);
      const blocks = [
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
      blocks.push(...buildPostWriteCheckBlocks(edit));
      return blocks;
    }
    case "patch": {
      const patch = toolData.patch;
      if (!patch) {
        break;
      }

      const patchText = extractStructuredPatchDisplayText(result.structuredResult);
      const blocks = [
        createBlock(formatPatchFiles(patch), { label: "Files", style: "code" }),
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
      blocks.push(...buildPostWriteCheckBlocks(patch));
      return blocks;
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

  const backgroundProcessBlocks = buildBackgroundProcessToolBlocks(
    result.toolName,
    result.structuredResult
  );
  if (backgroundProcessBlocks) {
    return backgroundProcessBlocks;
  }

  const ptyBlocks = buildPtyToolBlocks(
    result.toolName,
    result.structuredResult
  );
  if (ptyBlocks) {
    return ptyBlocks;
  }

  const markdownFriendlyBlocks = buildMarkdownFriendlyGenericBlocks(
    result.toolName,
    result.structuredResult
  );
  if (markdownFriendlyBlocks) {
    return markdownFriendlyBlocks;
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
    if (toolData.write.formatter && toolData.write.formatter.status !== "skipped") {
      metadata.push(formatFormatterMetadata(toolData.write.formatter));
    }
    if (toolData.write.diagnostics && toolData.write.diagnostics.status !== "skipped") {
      metadata.push(formatDiagnosticsMetadata(toolData.write.diagnostics));
    }
  }

  if (toolData.edit) {
    if (toolData.edit.formatter && toolData.edit.formatter.status !== "skipped") {
      metadata.push(formatFormatterMetadata(toolData.edit.formatter));
    }
    if (toolData.edit.diagnostics && toolData.edit.diagnostics.status !== "skipped") {
      metadata.push(formatDiagnosticsMetadata(toolData.edit.diagnostics));
    }
  }

  if (toolData.patch) {
    metadata.push(`${toolData.patch.operationCount} file(s)`);
    metadata.push(`+${toolData.patch.additions} -${toolData.patch.deletions}`);
    if (toolData.patch.formatter && toolData.patch.formatter.status !== "skipped") {
      metadata.push(formatFormatterMetadata(toolData.patch.formatter));
    }
    if (toolData.patch.diagnostics && toolData.patch.diagnostics.status !== "skipped") {
      metadata.push(formatDiagnosticsMetadata(toolData.patch.diagnostics));
    }
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
    lineCount,
    formatter: toFormatterResult(record.formatter) ?? undefined,
    diagnostics: toDiagnosticsResult(record.diagnostics) ?? undefined
  };
}

function buildPostWriteCheckBlocks(
  result: TerminalUiToolWriteResult | TerminalUiToolEditResult | TerminalUiToolPatchResult | undefined
): TerminalUiMessageBlock[] {
  if (!result) {
    return [];
  }

  const blocks: TerminalUiMessageBlock[] = [];
  if (result.formatter && result.formatter.status !== "skipped") {
    blocks.push(createBlock(formatFormatterResult(result.formatter), {
      label: "Formatter",
      tone: result.formatter.status === "failed" ? "warning" : "success",
      style: "code"
    }));
  }

  if (result.diagnostics && result.diagnostics.status !== "skipped") {
    blocks.push(createBlock(formatDiagnosticsResult(result.diagnostics), {
      label: "Diagnostics",
      tone: result.diagnostics.status === "issues"
        ? "warning"
        : result.diagnostics.status === "failed"
          ? "warning"
          : result.diagnostics.status === "pending"
            ? "info"
          : "success",
      style: "code"
    }));
  }

  return blocks;
}

function toFormatterResult(value: unknown): TerminalUiToolWriteResult["formatter"] | null {
  const record = asRecord(value);
  const status = asString(record?.status);
  if (!record || !isFormatterStatus(status)) {
    return null;
  }

  return {
    status,
    formatter: asString(record.formatter),
    command: Array.isArray(record.command)
      ? record.command.filter((item): item is string => typeof item === "string")
      : undefined,
    durationMs: asNumber(record.durationMs),
    exitCode: asNullableNumber(record.exitCode),
    signal: asNullableString(record.signal),
    stdout: asString(record.stdout),
    stderr: asString(record.stderr),
    message: asString(record.message)
  };
}

function toDiagnosticsResult(value: unknown): TerminalUiToolWriteResult["diagnostics"] | null {
  const record = asRecord(value);
  const status = asString(record?.status);
  const totalIssueCount = asNumber(record?.totalIssueCount);
  const truncated = asBoolean(record?.truncated);
  if (!record || !isDiagnosticsStatus(status) || totalIssueCount === undefined || truncated === undefined) {
    return null;
  }

  const issues = Array.isArray(record.issues)
    ? record.issues.flatMap((issue) => {
        const issueRecord = asRecord(issue);
        const filePath = asString(issueRecord?.filePath);
        const line = asNumber(issueRecord?.line);
        const character = asNumber(issueRecord?.character);
        const severity = asString(issueRecord?.severity);
        const code = asString(issueRecord?.code);
        const message = asString(issueRecord?.message);
        if (
          !filePath ||
          line === undefined ||
          character === undefined ||
          !severity ||
          !code ||
          !message
        ) {
          return [];
        }

        return [{
          filePath,
          line,
          character,
          severity,
          code,
          message,
          source: asString(issueRecord?.source)
        }];
      })
    : [];

  return {
    status,
    backend: asString(record.backend),
    issues,
    totalIssueCount,
    truncated,
    message: asString(record.message)
  };
}

function isFormatterStatus(value: string | undefined): value is NonNullable<TerminalUiToolWriteResult["formatter"]>["status"] {
  return value === "skipped" || value === "unchanged" || value === "formatted" || value === "failed";
}

function isDiagnosticsStatus(value: string | undefined): value is NonNullable<TerminalUiToolWriteResult["diagnostics"]>["status"] {
  return value === "skipped" || value === "pending" || value === "ok" || value === "issues" || value === "failed";
}

function formatFormatterResult(formatter: NonNullable<TerminalUiToolWriteResult["formatter"]>) {
  const lines = [`Status: ${formatter.status}`];
  if (formatter.formatter) {
    lines.push(`Formatter: ${formatter.formatter}`);
  }
  if (formatter.durationMs !== undefined) {
    lines.push(`Duration: ${formatter.durationMs} ms`);
  }
  if (formatter.exitCode !== undefined) {
    lines.push(`Exit: ${formatter.exitCode ?? formatter.signal ?? "unknown"}`);
  }
  if (formatter.command?.length) {
    lines.push(`Command: ${formatter.command.join(" ")}`);
  }
  if (formatter.message) {
    lines.push(`Message: ${formatter.message}`);
  }
  if (formatter.stdout?.trim()) {
    lines.push("", "Stdout:", formatter.stdout.trim());
  }
  if (formatter.stderr?.trim()) {
    lines.push("", "Stderr:", formatter.stderr.trim());
  }

  return lines.join("\n");
}

function formatDiagnosticsResult(diagnostics: NonNullable<TerminalUiToolWriteResult["diagnostics"]>) {
  if (diagnostics.status === "ok") {
    return "No TypeScript/JavaScript diagnostics reported.";
  }

  if (diagnostics.status === "pending") {
    return diagnostics.message ?? "Diagnostics are running in the background.";
  }

  if (diagnostics.status === "failed") {
    return diagnostics.message ?? "Diagnostics failed.";
  }

  const lines = diagnostics.issues.map((issue) =>
    `${issue.filePath}:${issue.line}:${issue.character} ${issue.severity.toUpperCase()} ${formatDiagnosticCode(issue)} ${issue.message}`
  );
  if (diagnostics.truncated) {
    lines.push(`... ${diagnostics.totalIssueCount - diagnostics.issues.length} more omitted`);
  }

  return lines.length > 0 ? lines.join("\n") : diagnostics.message ?? "Diagnostics reported no displayable issues.";
}

function formatDiagnosticCode(issue: { source?: string; code: string }) {
  return issue.source ? `[${issue.source} ${issue.code}]` : `[${issue.code}]`;
}

function formatFormatterMetadata(formatter: NonNullable<TerminalUiToolWriteResult["formatter"]>) {
  return formatter.formatter ? `Formatter: ${formatter.formatter} ${formatter.status}` : `Formatter: ${formatter.status}`;
}

function formatDiagnosticsMetadata(diagnostics: NonNullable<TerminalUiToolWriteResult["diagnostics"]>) {
  if (diagnostics.status === "issues") {
    return `Diagnostics: ${diagnostics.totalIssueCount}`;
  }

  return `Diagnostics: ${diagnostics.status}`;
}

function toDiagnosticsDisplayResult(event: LspDiagnosticCompletedEvent): DiagnosticsDisplayResult {
  return {
    status: event.status,
    backend: event.backend,
    issues: event.issues.map((issue) => ({ ...issue })),
    totalIssueCount: event.totalIssueCount,
    truncated: event.truncated,
    message: event.message
  };
}

function formatDiagnosticsFollowUpSummary(event: LspDiagnosticCompletedEvent) {
  const lines = [
    `File: ${event.filePath}`,
    `Status: ${event.status}`,
    `Source: ${event.source}`,
    `Completion: ${event.completionReason}`,
    `Started: ${event.startedAt}`,
    `Completed: ${event.completedAt}`,
    `Duration: ${event.durationMs} ms`
  ];
  if (event.backend) {
    lines.push(`Backend: ${event.backend}`);
  }
  lines.push(`Issues: ${event.totalIssueCount} total, ${event.issues.length} shown`);
  if (event.duplicateIssueCount > 0) {
    lines.push(`Deduped duplicates: ${event.duplicateIssueCount}`);
  }
  if (event.omittedIssueCount > 0) {
    lines.push(`Omitted after cap: ${event.omittedIssueCount}`);
  }
  if (event.groupedFileCount > 1) {
    lines.push(`Grouped files: ${event.groupedFileCount}`);
  }
  if (event.failureStreak > 0) {
    lines.push(`Failure streak: ${event.failureStreak}`);
  }
  if (event.circuitBreakerOpen) {
    lines.push(
      event.circuitBreakerOpenUntil
        ? `Circuit breaker: open until ${event.circuitBreakerOpenUntil}`
        : "Circuit breaker: open"
    );
  }
  if (event.message) {
    lines.push(`Message: ${event.message}`);
  }

  return lines.join("\n");
}

function diagnosticsTone(status: DiagnosticsDisplayResult["status"]): TerminalUiMessageBlockTone {
  if (status === "issues" || status === "failed") {
    return "warning";
  }

  if (status === "pending") {
    return "info";
  }

  return "success";
}

function toEditResult(value: unknown): TerminalUiToolEditResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const filePath = asString(record.filePath);
  const replaceAll = asBoolean(record.replaceAll);
  const matchCount = asNumber(record.matchCount);

  if (
    !filePath ||
    replaceAll === undefined ||
    matchCount === undefined
  ) {
    return null;
  }

  return {
    filePath,
    replaceAll,
    matchCount,
    formatter: toFormatterResult(record.formatter) ?? undefined,
    diagnostics: toDiagnosticsResult(record.diagnostics) ?? undefined
  };
}

function toPatchResult(value: unknown): TerminalUiToolPatchResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const filePath = asString(record.filePath);
  const operationCount = asNumber(record.operationCount);
  const additions = asNumber(record.additions);
  const deletions = asNumber(record.deletions);
  if (
    !filePath ||
    operationCount === undefined ||
    additions === undefined ||
    deletions === undefined ||
    !Array.isArray(record.files)
  ) {
    return null;
  }

  const files = record.files.flatMap((item) => {
    const file = asRecord(item);
    const type = asString(file?.type);
    const itemFilePath = asString(file?.filePath);
    const itemAdditions = asNumber(file?.additions);
    const itemDeletions = asNumber(file?.deletions);
    if (
      !isPatchFileType(type) ||
      !itemFilePath ||
      itemAdditions === undefined ||
      itemDeletions === undefined
    ) {
      return [];
    }

    return [{
      type,
      filePath: itemFilePath,
      sourcePath: asString(file?.sourcePath),
      bytes: asNumber(file?.bytes),
      lineCount: asNumber(file?.lineCount),
      additions: itemAdditions,
      deletions: itemDeletions,
      matchStrategies: Array.isArray(file?.matchStrategies)
        ? file.matchStrategies.filter((strategy): strategy is string => typeof strategy === "string")
        : [],
      formatter: toFormatterResult(file?.formatter) ?? undefined,
      diagnostics: toDiagnosticsResult(file?.diagnostics) ?? undefined
    }];
  });

  return {
    filePath,
    operationCount,
    additions,
    deletions,
    files,
    formatter: toFormatterResult(record.formatter) ?? undefined,
    diagnostics: toDiagnosticsResult(record.diagnostics) ?? undefined
  };
}

function isPatchFileType(value: string | undefined): value is TerminalUiToolPatchResult["files"][number]["type"] {
  return value === "add" || value === "update" || value === "delete" || value === "move";
}

function formatPatchFiles(patch: TerminalUiToolPatchResult) {
  return patch.files.map((file) => {
    const prefix = file.type === "add"
      ? "A"
      : file.type === "delete"
        ? "D"
        : file.type === "move"
          ? "R"
          : "M";
    const filePath = file.type === "move" && file.sourcePath
      ? `${file.sourcePath} -> ${file.filePath}`
      : file.filePath;
    const size = file.bytes === undefined ? "" : `, ${formatBytes(file.bytes)}`;
    const lines = file.lineCount === undefined ? "" : `, ${file.lineCount} lines`;
    const strategies = file.matchStrategies.length > 0
      ? `, ${file.matchStrategies.join(", ")}`
      : "";
    return `${prefix} ${filePath} (+${file.additions} -${file.deletions}${size}${lines}${strategies})`;
  }).join("\n");
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

function extractStructuredPatchDisplayText(value: unknown) {
  const record = asRecord(value);
  if (!record) {
    return "";
  }

  const rawLines = extractStructuredPatchLines(record);
  if (rawLines.length === 0) {
    return "";
  }

  return filterStructuredPatchDisplayLines(rawLines).join("\n");
}

function filterStructuredPatchDisplayLines(lines: string[]) {
  const showFileHeaders = countDiffPatchFileHeaders(lines) > 1;
  const filteredLines: string[] = [];
  const hunkTracker = createDiffPatchHunkTracker();

  for (const line of lines) {
    const insideParsedHunk = isInsideDiffPatchHunk(hunkTracker);

    if (!insideParsedHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      if (showFileHeaders) {
        filteredLines.push(line);
      }
      continue;
    }

    filteredLines.push(line);

    const hunk = parseDiffPatchHunkHeader(line);
    if (hunk) {
      setDiffPatchHunkTracker(hunkTracker, hunk);
      continue;
    }

    advanceDiffPatchHunkTracker(hunkTracker, line);
  }

  return filteredLines;
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

    return normalizeStructuredPatchHunkLines({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines
    });
  });
}

function normalizeStructuredPatchHunkLines(options: {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}) {
  const hunkHeader = `@@ -${formatStructuredPatchRange(options.oldStart, options.oldLines)} +${formatStructuredPatchRange(options.newStart, options.newLines)} @@`;
  const hunkHeaderIndex = options.lines.findIndex((line) => line.startsWith("@@"));

  if (hunkHeaderIndex >= 0) {
    if (isStructuredPatchHunkHeader(options.lines[hunkHeaderIndex]!)) {
      return options.lines;
    }

    return [
      ...options.lines.slice(0, hunkHeaderIndex),
      hunkHeader,
      ...options.lines.slice(hunkHeaderIndex + 1)
    ];
  }

  const firstPatchLineIndex = options.lines.findIndex(
    (line) => !line.startsWith("--- ") && !line.startsWith("+++ ")
  );
  const insertionIndex = firstPatchLineIndex >= 0 ? firstPatchLineIndex : options.lines.length;

  return [
    ...options.lines.slice(0, insertionIndex),
    hunkHeader,
    ...options.lines.slice(insertionIndex)
  ];
}

function isStructuredPatchHunkHeader(line: string) {
  return /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.test(line);
}

function formatStructuredPatchRange(start: number, count: number) {
  return `${start},${count}`;
}

function formatToolError(error: ParsedToolCallExecutionResult["error"], fallback: string) {
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

function buildBackgroundProcessToolBlocks(
  toolName: string,
  structuredResult: unknown
): TerminalUiMessageBlock[] | null {
  if (!BACKGROUND_PROCESS_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const record = asRecord(structuredResult);
  if (!record) {
    return null;
  }

  if (toolName === "ProcessStart") {
    return buildProcessStartBlocks(record);
  }

  if (toolName === "ProcessList") {
    return buildProcessListBlocks(record);
  }

  if (toolName === "ProcessRead") {
    return buildProcessReadBlocks(record);
  }

  if (toolName === "ProcessStop") {
    return buildProcessStopBlocks(record);
  }

  return null;
}

function buildProcessStartBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const details = formatProcessDetails(record, {
    includeLogs: true,
    includeTiming: true
  });
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(details, {
      label: "Process",
      tone: processStatusTone(status),
      style: "code"
    })
  ];
  const command = asString(record.command);
  if (command) {
    blocks.push(createBlock(`$ ${command}`, { label: "Command", style: "code" }));
  }
  const stdoutPreview = asString(record.stdout_preview)?.trim();
  const stderrPreview = asString(record.stderr_preview)?.trim();
  if (stdoutPreview) {
    blocks.push(createBlock(stdoutPreview, { label: "Stdout Preview", tone: "success", style: "code" }));
  }
  if (stderrPreview) {
    blocks.push(createBlock(stderrPreview, { label: "Stderr Preview", tone: "warning", style: "code" }));
  }

  return blocks;
}

function buildProcessListBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const processes = asRecordArray(record.processes);
  if (processes.length === 0) {
    return [createBlock("No managed background processes are running.", { label: "Processes", tone: "muted" })];
  }

  return [
    createBlock(processes.map(formatProcessSummaryLine).join("\n"), {
      label: "Processes",
      tone: "success",
      style: "code"
    })
  ];
}

function buildProcessReadBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const details = [
    `Process: ${asString(record.process_id) ?? "(unknown)"}`,
    `Stream: ${asString(record.stream) ?? "combined"}`,
    ...(asString(record.log_path) ? [`Log: ${asString(record.log_path)}`] : []),
    ...(asNumber(record.offset) !== undefined ? [`Offset: ${asNumber(record.offset)}`] : []),
    ...(asNumber(record.bytes) !== undefined ? [`Bytes: ${asNumber(record.bytes)}`] : []),
    ...(asBoolean(record.eof) !== undefined ? [`EOF: ${asBoolean(record.eof) ? "yes" : "no"}`] : [])
  ];

  return [
    createBlock(asString(record.content) ?? "", {
      label: "Log",
      tone: "success",
      style: "code"
    }),
    createBlock(details.join("\n"), {
      label: "Details",
      style: "code"
    })
  ];
}

function buildProcessStopBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const lines = [
    `Process: ${asString(record.process_id) ?? "(unknown)"}`,
    `Status: ${status ?? "unknown"}`,
    ...(asString(record.message) ? [`Message: ${asString(record.message)}`] : []),
    ...formatNullableExitLines(record)
  ];
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(lines.join("\n"), {
      label: "Stop",
      tone: processStatusTone(status),
      style: "code"
    })
  ];
  const processRecord = asRecord(record.process);
  if (processRecord) {
    blocks.push(createBlock(formatProcessSummaryLine(processRecord), {
      label: "Process",
      style: "code"
    }));
  }

  return blocks;
}

function formatProcessDetails(
  record: Record<string, unknown>,
  options: { includeLogs?: boolean; includeTiming?: boolean } = {}
): string {
  const lines = [
    `Status: ${asString(record.status) ?? "unknown"}`,
    `Process: ${asString(record.process_id) ?? "(unknown)"}`,
    ...formatNullablePidLine(record),
    ...(asString(record.cwd) ? [`CWD: ${asString(record.cwd)}`] : []),
    ...formatProcessEndpointLines(record),
    ...formatNullableExitLines(record),
    ...formatProcessWarningLines(record),
    ...(asString(record.last_error) ? [`Error: ${asString(record.last_error)}`] : [])
  ];

  if (options.includeLogs) {
    lines.push(...formatProcessLogLines(record));
  }

  if (options.includeTiming) {
    lines.push(
      ...(asString(record.started_at) ? [`Started: ${asString(record.started_at)}`] : []),
      ...(asString(record.updated_at) ? [`Updated: ${asString(record.updated_at)}`] : []),
      ...(asString(record.exited_at) ? [`Exited: ${asString(record.exited_at)}`] : [])
    );
  }

  return lines.join("\n");
}

function formatProcessSummaryLine(record: Record<string, unknown>): string {
  const parts = [
    asString(record.process_id) ?? "(unknown)",
    asString(record.status) ?? "unknown",
    ...formatNullablePidLine(record),
    asString(record.command) ? truncateInline(asString(record.command)!, 96) : "(no command)"
  ];
  const urls = asStringArray(record.detected_urls);
  if (urls.length > 0) {
    parts.push(urls[0]!);
  }
  const error = asString(record.last_error);
  if (error) {
    parts.push(`error: ${truncateInline(error, 80)}`);
  }
  const warnings = asStringArray(record.warnings);
  if (warnings.length > 0) {
    parts.push(`warning: ${truncateInline(warnings[0]!, 80)}`);
  }

  return `- ${parts.join(" | ")}`;
}

function formatProcessEndpointLines(record: Record<string, unknown>): string[] {
  const urls = asStringArray(record.detected_urls);
  const ports = asNumberArray(record.detected_ports);
  return [
    ...(urls.length > 0 ? [`URL: ${urls.join(", ")}`] : []),
    ...(ports.length > 0 ? [`Port: ${ports.join(", ")}`] : []),
    ...(asString(record.startup_matched) ? [`Startup matched: ${asString(record.startup_matched)}`] : []),
    ...(asBoolean(record.startup_timed_out) === true ? ["Startup observation timed out"] : [])
  ];
}

function formatProcessLogLines(record: Record<string, unknown>): string[] {
  return [
    ...(asString(record.combined_log_path) ? [`Log: ${asString(record.combined_log_path)}`] : []),
    ...(asString(record.stdout_log_path) ? [`Stdout log: ${asString(record.stdout_log_path)}`] : []),
    ...(asString(record.stderr_log_path) ? [`Stderr log: ${asString(record.stderr_log_path)}`] : [])
  ];
}

function formatProcessWarningLines(record: Record<string, unknown>): string[] {
  const warnings = asStringArray(record.warnings);
  return warnings.map((warning) => `Warning: ${warning}`);
}

function formatNullablePidLine(record: Record<string, unknown>): string[] {
  if (record.pid === null) {
    return ["PID: (unknown)"];
  }

  const pid = asNumber(record.pid);
  return pid === undefined ? [] : [`PID: ${pid}`];
}

function formatNullableExitLines(record: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if ("exit_code" in record) {
    lines.push(`Exit: ${record.exit_code === null ? "null" : asNumber(record.exit_code) ?? "unknown"}`);
  }
  if ("signal" in record) {
    lines.push(`Signal: ${record.signal === null ? "null" : asString(record.signal) ?? "unknown"}`);
  }
  return lines;
}

function processStatusTone(status: string | undefined): TerminalUiMessageBlockTone {
  if (status === "running") {
    return "success";
  }

  if (status === "failed") {
    return "danger";
  }

  if (status === "starting") {
    return "info";
  }

  if (status === "exited" || status === "stopped" || status === "not_found") {
    return "warning";
  }

  return "default";
}

function buildPtyToolBlocks(
  toolName: string,
  structuredResult: unknown
): TerminalUiMessageBlock[] | null {
  if (!PTY_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const record = asRecord(structuredResult);
  if (!record) {
    return null;
  }

  if (toolName === "PtyCreate") {
    return buildPtyCreateBlocks(record);
  }

  if (toolName === "PtyList") {
    return buildPtyListBlocks(record);
  }

  if (toolName === "PtyRead") {
    return buildPtyReadBlocks(record);
  }

  if (toolName === "PtyWrite") {
    return buildPtyWriteBlocks(record);
  }

  if (toolName === "PtyResize") {
    return buildPtyResizeBlocks(record);
  }

  if (toolName === "PtyClose") {
    return buildPtyCloseBlocks(record);
  }

  return null;
}

function buildPtyCreateBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(formatPtyDetails(record, { includeTiming: true }), {
      label: "PTY",
      tone: ptyStatusTone(status),
      style: "code"
    })
  ];
  const command = formatPtyCommand(record);
  if (command) {
    blocks.push(createBlock(`$ ${command}`, { label: "Command", style: "code" }));
  }
  const note = asString(record.note);
  if (note) {
    blocks.push(createBlock(note, { label: "Note", tone: status === "failed" ? "warning" : "info" }));
  }

  return blocks;
}

function buildPtyListBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const sessions = asRecordArray(record.sessions);
  if (sessions.length === 0) {
    return [createBlock("No interactive PTY sessions are active.", { label: "PTY Sessions", tone: "muted" })];
  }

  return [
    createBlock(sessions.map(formatPtySummaryLine).join("\n"), {
      label: "PTY Sessions",
      tone: "success",
      style: "code"
    })
  ];
}

function buildPtyReadBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const details = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    ...(asNumber(record.cursor) !== undefined ? [`Cursor: ${asNumber(record.cursor)}`] : []),
    ...(asNumber(record.next_cursor) !== undefined ? [`Next cursor: ${asNumber(record.next_cursor)}`] : []),
    ...(asNumber(record.buffer_cursor) !== undefined ? [`Buffer cursor: ${asNumber(record.buffer_cursor)}`] : []),
    ...(asNumber(record.bytes) !== undefined ? [`Bytes: ${asNumber(record.bytes)}`] : []),
    ...(asBoolean(record.eof) !== undefined ? [`EOF: ${asBoolean(record.eof) ? "yes" : "no"}`] : [])
  ];
  const session = asRecord(record.session);
  if (session) {
    details.push(
      `Status: ${asString(session.status) ?? "unknown"}`,
      ...(asString(session.title) ? [`Title: ${asString(session.title)}`] : []),
      ...(asString(session.cwd) ? [`CWD: ${asString(session.cwd)}`] : [])
    );
  }

  return [
    createBlock(asString(record.content) ?? "", {
      label: "PTY Output",
      tone: "success",
      style: "code"
    }),
    createBlock(details.join("\n"), {
      label: "Details",
      style: "code"
    })
  ];
}

function buildPtyWriteBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const session = asRecord(record.session);
  const lines = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    ...(asNumber(record.bytes) !== undefined ? [`Bytes written: ${asNumber(record.bytes)}`] : []),
    ...(asNumber(record.cursor) !== undefined ? [`Cursor: ${asNumber(record.cursor)}`] : []),
    ...(session ? [`Status: ${asString(session.status) ?? "unknown"}`] : [])
  ];

  return [
    createBlock(lines.join("\n"), {
      label: "Write",
      tone: ptyStatusTone(asString(session?.status)),
      style: "code"
    })
  ];
}

function buildPtyResizeBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const session = asRecord(record.session);
  const lines = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    `Size: ${asNumber(record.cols) ?? "?"}x${asNumber(record.rows) ?? "?"}`,
    ...(session ? [`Status: ${asString(session.status) ?? "unknown"}`] : [])
  ];

  return [
    createBlock(lines.join("\n"), {
      label: "Resize",
      tone: ptyStatusTone(asString(session?.status)),
      style: "code"
    })
  ];
}

function buildPtyCloseBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const lines = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    `Status: ${status ?? "unknown"}`,
    ...(asString(record.message) ? [`Message: ${asString(record.message)}`] : [])
  ];
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(lines.join("\n"), {
      label: "Close",
      tone: ptyStatusTone(status),
      style: "code"
    })
  ];
  const session = asRecord(record.session);
  if (session) {
    blocks.push(createBlock(formatPtySummaryLine(session), {
      label: "PTY",
      style: "code"
    }));
  }

  return blocks;
}

function formatPtyDetails(
  record: Record<string, unknown>,
  options: { includeTiming?: boolean } = {}
): string {
  const lines = [
    `Status: ${asString(record.status) ?? "unknown"}`,
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    ...formatNullablePidLine(record),
    ...(asString(record.title) ? [`Title: ${asString(record.title)}`] : []),
    ...(asString(record.cwd) ? [`CWD: ${asString(record.cwd)}`] : []),
    `Size: ${asNumber(record.cols) ?? "?"}x${asNumber(record.rows) ?? "?"}`,
    ...formatNullableExitLines(record),
    ...(asString(record.last_error) ? [`Error: ${asString(record.last_error)}`] : [])
  ];

  if (options.includeTiming) {
    lines.push(
      ...(asString(record.created_at) ? [`Created: ${asString(record.created_at)}`] : []),
      ...(asString(record.updated_at) ? [`Updated: ${asString(record.updated_at)}`] : []),
      ...(asString(record.exited_at) ? [`Exited: ${asString(record.exited_at)}`] : [])
    );
  }

  return lines.join("\n");
}

function formatPtySummaryLine(record: Record<string, unknown>): string {
  const command = formatPtyCommand(record);
  const parts = [
    asString(record.pty_id) ?? "(unknown)",
    asString(record.status) ?? "unknown",
    ...formatNullablePidLine(record),
    asString(record.title) ?? "(untitled)",
    command ? truncateInline(command, 96) : "(no command)"
  ];
  const error = asString(record.last_error);
  if (error) {
    parts.push(`error: ${truncateInline(error, 80)}`);
  }

  return `- ${parts.join(" | ")}`;
}

function formatPtyCommand(record: Record<string, unknown>): string | undefined {
  const command = asString(record.command);
  if (!command) {
    return undefined;
  }

  const args = asStringArray(record.args);
  return [command, ...args].join(" ");
}

function ptyStatusTone(status: string | undefined): TerminalUiMessageBlockTone {
  if (status === "running") {
    return "success";
  }

  if (status === "failed") {
    return "danger";
  }

  if (status === "exited" || status === "closed" || status === "not_found") {
    return "warning";
  }

  return "default";
}

function buildMarkdownFriendlyGenericBlocks(
  toolName: string,
  structuredResult: unknown
): TerminalUiMessageBlock[] | null {
  if (!isMarkdownFriendlyToolName(toolName)) {
    return null;
  }

  if (typeof structuredResult === "string") {
    return [createBlock(structuredResult, { label: "Output", tone: "success" })];
  }

  const record = asRecord(structuredResult);
  if (!record) {
    return null;
  }

  const content = extractMarkdownFriendlyToolContent(record);
  if (!content) {
    return null;
  }

  const blocks: TerminalUiMessageBlock[] = [
    createBlock(content, { label: "Output", tone: "success" })
  ];
  const warnings = asStringArray(record.warnings);
  if (warnings.length > 0) {
    blocks.push(createBlock(warnings.map((warning) => `- ${warning}`).join("\n"), {
      label: "Warnings",
      tone: "warning"
    }));
  }

  return blocks;
}

function extractMarkdownFriendlyToolContent(record: Record<string, unknown>): string | null {
  const directContent = asString(record.content)?.trim();
  if (directContent) {
    return directContent;
  }

  const text = asString(record.text)?.trim();
  if (text) {
    return text;
  }

  const filenames = asStringArray(record.filenames);
  if (filenames.length > 0) {
    return filenames.map((filename) => `- \`${filename}\``).join("\n");
  }

  const items = asStringArray(record.items);
  if (items.length > 0) {
    return items.map((item) => `- ${item}`).join("\n");
  }

  const entries = asStringArray(record.entries);
  if (entries.length > 0) {
    return entries.map((entry) => `- ${entry}`).join("\n");
  }

  const searchResults = asRecordArray(record.results);
  if (searchResults.length > 0) {
    const lines = searchResults.map((item, index) => {
      const title =
        asString(item.title) ??
        asString(item.name) ??
        asString(item.url) ??
        `Result ${index + 1}`;
      const url = asString(item.url);
      const snippet = asString(item.snippet) ?? asString(item.description);
      const line = url ? `${index + 1}. [${title}](${url})` : `${index + 1}. ${title}`;
      if (!snippet || snippet.trim().length === 0) {
        return line;
      }

      return `${line}\n   ${snippet.trim()}`;
    });
    const context = asString(record.context)?.trim();
    if (context) {
      lines.push("", "Context:", context);
    }

    return lines.join("\n");
  }

  const message = asString(record.message)?.trim();
  if (message) {
    return message;
  }

  return null;
}

function isMarkdownFriendlyToolName(toolName: string) {
  const normalizedToolName = toolName.trim().toLowerCase();
  return MARKDOWN_FRIENDLY_TOOL_NAME_TOKENS.some((token) => normalizedToolName.includes(token));
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
      structuredResult: envelope.result ?? envelope.error,
      ok: false,
      status: asString(envelope.status),
      error: toToolResultError(envelope.error)
    };
  }

  return {
    toolName,
    parsedArgs,
    displayResult,
    structuredResult: envelope.result ?? envelope,
    ok: true,
    status: asString(envelope.status)
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
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
