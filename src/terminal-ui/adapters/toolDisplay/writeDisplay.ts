import type {
  TerminalUiMessageBlock,
  TerminalUiToolEditResult,
  TerminalUiToolPatchResult,
  TerminalUiToolWriteResult
} from "../../state/types.js";
import {
  advanceDiffPatchHunkTracker,
  countDiffPatchFileHeaders,
  createDiffPatchHunkTracker,
  isInsideDiffPatchHunk,
  parseDiffPatchHunkHeader,
  setDiffPatchHunkTracker
} from "../../utils/diffPatchParsing.js";
import {
  asBoolean,
  asNullableNumber,
  asNullableString,
  asNumber,
  asRecord,
  asRecordArray,
  asString,
  asStringArray,
  createBlock,
  formatBytes,
  type DiagnosticsDisplayResult
} from "./common.js";

// Write / Edit / Patch 展示与写后检查。

export function toWriteResult(
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

export function buildPostWriteCheckBlocks(
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

export function toFormatterResult(value: unknown): TerminalUiToolWriteResult["formatter"] | null {
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

export function toDiagnosticsResult(value: unknown): TerminalUiToolWriteResult["diagnostics"] | null {
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

export function isFormatterStatus(value: string | undefined): value is NonNullable<TerminalUiToolWriteResult["formatter"]>["status"] {
  return value === "skipped" || value === "unchanged" || value === "formatted" || value === "failed";
}

export function isDiagnosticsStatus(value: string | undefined): value is NonNullable<TerminalUiToolWriteResult["diagnostics"]>["status"] {
  return value === "skipped" || value === "pending" || value === "ok" || value === "issues" || value === "failed";
}

export function formatFormatterResult(formatter: NonNullable<TerminalUiToolWriteResult["formatter"]>) {
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

export function formatDiagnosticsResult(diagnostics: NonNullable<TerminalUiToolWriteResult["diagnostics"]>) {
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

export function formatDiagnosticCode(issue: { source?: string; code: string }) {
  return issue.source ? `[${issue.source} ${issue.code}]` : `[${issue.code}]`;
}

export function formatFormatterMetadata(formatter: NonNullable<TerminalUiToolWriteResult["formatter"]>) {
  return formatter.formatter ? `Formatter: ${formatter.formatter} ${formatter.status}` : `Formatter: ${formatter.status}`;
}

export function formatDiagnosticsMetadata(diagnostics: NonNullable<TerminalUiToolWriteResult["diagnostics"]>) {
  if (diagnostics.status === "issues") {
    return `Diagnostics: ${diagnostics.totalIssueCount}`;
  }

  return `Diagnostics: ${diagnostics.status}`;
}

export function toEditResult(value: unknown): TerminalUiToolEditResult | null {
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

export function toPatchResult(value: unknown): TerminalUiToolPatchResult | null {
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

export function isPatchFileType(value: string | undefined): value is TerminalUiToolPatchResult["files"][number]["type"] {
  return value === "add" || value === "update" || value === "delete" || value === "move";
}

export function formatPatchFiles(patch: TerminalUiToolPatchResult) {
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

export function extractStructuredPatchDisplayText(value: unknown) {
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

export function filterStructuredPatchDisplayLines(lines: string[]) {
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

export function extractStructuredPatchLines(record: Record<string, unknown>) {
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

export function normalizeStructuredPatchHunkLines(options: {
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

export function isStructuredPatchHunkHeader(line: string) {
  return /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.test(line);
}

export function formatStructuredPatchRange(start: number, count: number) {
  return `${start},${count}`;
}
