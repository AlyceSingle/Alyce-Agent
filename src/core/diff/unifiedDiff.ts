import { TextDecoder } from "node:util";

export type UnifiedDiffStatus = "added" | "modified" | "deleted" | "unchanged";

export interface UnifiedDiffContentSnapshot {
  existed: boolean;
  content: Buffer;
}

export interface UnifiedDiffFileInput {
  path: string;
  status: UnifiedDiffStatus;
  before: UnifiedDiffContentSnapshot;
  after: UnifiedDiffContentSnapshot;
}

export interface UnifiedDiffFileResult {
  path: string;
  status: UnifiedDiffStatus;
  text: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  beforeBytes: number;
  afterBytes: number;
}

type LineDiffOp =
  | { type: "context"; line: string }
  | { type: "add"; line: string }
  | { type: "delete"; line: string };

const MAX_TEXT_DIFF_BYTES = 512 * 1024;
const MAX_LCS_CELLS = 250_000;
const MAX_RENDERED_DIFF_LINES = 2_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function buildUnifiedDiffForFile(input: UnifiedDiffFileInput): UnifiedDiffFileResult {
  const beforeBytes = input.before.existed ? input.before.content.byteLength : 0;
  const afterBytes = input.after.existed ? input.after.content.byteLength : 0;
  if (input.status === "unchanged") {
    return {
      path: input.path,
      status: input.status,
      text: "",
      additions: 0,
      deletions: 0,
      binary: false,
      truncated: false,
      beforeBytes,
      afterBytes
    };
  }

  const header = buildFileHeader(input);
  if (isLikelyBinaryBuffer(input.before.content) || isLikelyBinaryBuffer(input.after.content)) {
    return {
      path: input.path,
      status: input.status,
      text: [
        ...header,
        `Binary files ${beforeLabel(input)} and ${afterLabel(input)} differ`
      ].join("\n"),
      additions: 0,
      deletions: 0,
      binary: true,
      truncated: false,
      beforeBytes,
      afterBytes
    };
  }

  const tooLarge = beforeBytes > MAX_TEXT_DIFF_BYTES || afterBytes > MAX_TEXT_DIFF_BYTES;
  const beforeText = decodeUtf8(input.before.content);
  const afterText = decodeUtf8(input.after.content);
  if (beforeText === undefined || afterText === undefined) {
    return {
      path: input.path,
      status: input.status,
      text: [
        ...header,
        `Binary files ${beforeLabel(input)} and ${afterLabel(input)} differ`
      ].join("\n"),
      additions: 0,
      deletions: 0,
      binary: true,
      truncated: false,
      beforeBytes,
      afterBytes
    };
  }

  const beforeLines = splitTextLines(input.before.existed ? beforeText : "");
  const afterLines = splitTextLines(input.after.existed ? afterText : "");
  const ops = tooLarge
    ? buildReplacementDiff(beforeLines, afterLines)
    : buildLineDiff(beforeLines, afterLines);
  const { additions, deletions } = countLineStats(ops);
  const body = renderDiffBody(ops);
  const truncated = tooLarge || body.truncated;

  return {
    path: input.path,
    status: input.status,
    text: [
      ...header,
      `@@ -${formatRange(beforeLines.length)} +${formatRange(afterLines.length)} @@`,
      ...body.lines,
      tooLarge ? `[diff omitted after header: file exceeds ${formatBytes(MAX_TEXT_DIFF_BYTES)} text diff limit]` : null
    ].filter((line): line is string => line !== null).join("\n"),
    additions,
    deletions,
    binary: false,
    truncated,
    beforeBytes,
    afterBytes
  };
}

export function isLikelyBinaryBuffer(content: Buffer): boolean {
  if (content.byteLength === 0) {
    return false;
  }

  const sample = content.subarray(0, Math.min(content.byteLength, 8_000));
  return sample.includes(0);
}

function buildFileHeader(input: UnifiedDiffFileInput): string[] {
  return [
    `diff --git a/${input.path} b/${input.path}`,
    input.status === "added" ? "new file mode 100644" : null,
    input.status === "deleted" ? "deleted file mode 100644" : null,
    `--- ${beforeLabel(input)}`,
    `+++ ${afterLabel(input)}`
  ].filter((line): line is string => line !== null);
}

function beforeLabel(input: UnifiedDiffFileInput): string {
  return input.before.existed ? `a/${input.path}` : "/dev/null";
}

function afterLabel(input: UnifiedDiffFileInput): string {
  return input.after.existed ? `b/${input.path}` : "/dev/null";
}

function decodeUtf8(content: Buffer): string | undefined {
  try {
    return UTF8_DECODER.decode(content);
  } catch {
    return undefined;
  }
}

function splitTextLines(value: string): string[] {
  if (!value) {
    return [];
  }

  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
}

function buildLineDiff(beforeLines: string[], afterLines: string[]): LineDiffOp[] {
  if (beforeLines.length * afterLines.length > MAX_LCS_CELLS) {
    return buildReplacementDiff(beforeLines, afterLines);
  }

  const columns = afterLines.length + 1;
  const table = new Uint32Array((beforeLines.length + 1) * columns);
  const at = (row: number, column: number) => row * columns + column;

  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let column = afterLines.length - 1; column >= 0; column -= 1) {
      table[at(row, column)] = beforeLines[row] === afterLines[column]
        ? table[at(row + 1, column + 1)] + 1
        : Math.max(table[at(row + 1, column)], table[at(row, column + 1)]);
    }
  }

  const ops: LineDiffOp[] = [];
  let row = 0;
  let column = 0;
  while (row < beforeLines.length && column < afterLines.length) {
    if (beforeLines[row] === afterLines[column]) {
      ops.push({ type: "context", line: beforeLines[row] ?? "" });
      row += 1;
      column += 1;
      continue;
    }

    if (table[at(row + 1, column)] >= table[at(row, column + 1)]) {
      ops.push({ type: "delete", line: beforeLines[row] ?? "" });
      row += 1;
    } else {
      ops.push({ type: "add", line: afterLines[column] ?? "" });
      column += 1;
    }
  }

  while (row < beforeLines.length) {
    ops.push({ type: "delete", line: beforeLines[row] ?? "" });
    row += 1;
  }

  while (column < afterLines.length) {
    ops.push({ type: "add", line: afterLines[column] ?? "" });
    column += 1;
  }

  return ops;
}

function buildReplacementDiff(beforeLines: string[], afterLines: string[]): LineDiffOp[] {
  return [
    ...beforeLines.map((line): LineDiffOp => ({ type: "delete", line })),
    ...afterLines.map((line): LineDiffOp => ({ type: "add", line }))
  ];
}

function countLineStats(ops: LineDiffOp[]) {
  return ops.reduce(
    (stats, op) => {
      if (op.type === "add") {
        stats.additions += 1;
      } else if (op.type === "delete") {
        stats.deletions += 1;
      }

      return stats;
    },
    { additions: 0, deletions: 0 }
  );
}

function renderDiffBody(ops: LineDiffOp[]): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  for (const op of ops) {
    if (lines.length >= MAX_RENDERED_DIFF_LINES) {
      truncated = true;
      break;
    }

    lines.push(`${getLinePrefix(op.type)}${op.line}`);
  }

  if (truncated) {
    lines.push(`[diff truncated after ${MAX_RENDERED_DIFF_LINES} rendered lines]`);
  }

  return { lines, truncated };
}

function getLinePrefix(type: LineDiffOp["type"]): string {
  if (type === "add") {
    return "+";
  }

  if (type === "delete") {
    return "-";
  }

  return " ";
}

function formatRange(lineCount: number): string {
  return lineCount === 0 ? "0,0" : `1,${lineCount}`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  }

  return `${Math.ceil(value / 1024)} KiB`;
}
