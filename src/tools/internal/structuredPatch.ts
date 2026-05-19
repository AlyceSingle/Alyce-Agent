export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

type LineDiffOp =
  | { type: "context"; line: string }
  | { type: "add"; line: string }
  | { type: "remove"; line: string };

const MAX_LCS_CELLS = 250_000;
const HUNK_CONTEXT_LINE_COUNT = 1;

export function createStructuredPatch(options: {
  filePath?: string;
  oldContent: string;
  newContent: string;
  includeFileHeader?: boolean;
}): StructuredPatchHunk[] {
  if (options.oldContent === options.newContent) {
    return [];
  }

  const oldLines = splitTextLines(options.oldContent);
  const newLines = splitTextLines(options.newContent);
  const ops = buildLineDiff(oldLines, newLines);
  const hunks = buildStructuredPatchHunks(ops);
  const visibleHunks = hunks.length > 0
    ? hunks
    : buildTrailingNewlineOnlyHunks(options.oldContent, options.newContent, oldLines, newLines);
  const includeFileHeader = Boolean(options.includeFileHeader && options.filePath);

  return visibleHunks.map((hunk, index) => ({
    ...hunk,
    lines: [
      ...(includeFileHeader && index === 0
        ? [`--- ${options.filePath}`, `+++ ${options.filePath}`]
        : []),
      `@@ -${formatHunkRange(hunk.oldStart, hunk.oldLines)} +${formatHunkRange(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines
    ]
  }));
}

function splitTextLines(content: string) {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function buildLineDiff(oldLines: string[], newLines: string[]): LineDiffOp[] {
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return buildPrefixSuffixDiff(oldLines, newLines);
  }

  const columns = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * columns);
  const at = (row: number, column: number) => row * columns + column;

  for (let row = oldLines.length - 1; row >= 0; row -= 1) {
    for (let column = newLines.length - 1; column >= 0; column -= 1) {
      table[at(row, column)] = oldLines[row] === newLines[column]
        ? table[at(row + 1, column + 1)] + 1
        : Math.max(table[at(row + 1, column)], table[at(row, column + 1)]);
    }
  }

  const ops: LineDiffOp[] = [];
  let row = 0;
  let column = 0;
  while (row < oldLines.length && column < newLines.length) {
    if (oldLines[row] === newLines[column]) {
      ops.push({ type: "context", line: oldLines[row] ?? "" });
      row += 1;
      column += 1;
      continue;
    }

    if (table[at(row + 1, column)] >= table[at(row, column + 1)]) {
      ops.push({ type: "remove", line: oldLines[row] ?? "" });
      row += 1;
    } else {
      ops.push({ type: "add", line: newLines[column] ?? "" });
      column += 1;
    }
  }

  while (row < oldLines.length) {
    ops.push({ type: "remove", line: oldLines[row] ?? "" });
    row += 1;
  }

  while (column < newLines.length) {
    ops.push({ type: "add", line: newLines[column] ?? "" });
    column += 1;
  }

  return ops;
}

function buildPrefixSuffixDiff(oldLines: string[], newLines: string[]): LineDiffOp[] {
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let oldSuffixStart = oldLines.length;
  let newSuffixStart = newLines.length;
  while (
    oldSuffixStart > prefixLength &&
    newSuffixStart > prefixLength &&
    oldLines[oldSuffixStart - 1] === newLines[newSuffixStart - 1]
  ) {
    oldSuffixStart -= 1;
    newSuffixStart -= 1;
  }

  return [
    ...oldLines.slice(0, prefixLength).map((line): LineDiffOp => ({ type: "context", line })),
    ...oldLines.slice(prefixLength, oldSuffixStart).map((line): LineDiffOp => ({ type: "remove", line })),
    ...newLines.slice(prefixLength, newSuffixStart).map((line): LineDiffOp => ({ type: "add", line })),
    ...oldLines.slice(oldSuffixStart).map((line): LineDiffOp => ({ type: "context", line }))
  ];
}

function buildStructuredPatchHunks(ops: LineDiffOp[]): StructuredPatchHunk[] {
  const positions = buildPatchLinePositions(ops);
  const ranges = collectChangedLineRanges(ops);

  return ranges.map((range) => {
    const startPosition = positions[range.start] ?? { oldLine: 1, newLine: 1 };
    let oldLines = 0;
    let newLines = 0;
    const lines: string[] = [];

    for (let index = range.start; index < range.end; index += 1) {
      const op = ops[index]!;
      if (op.type === "context") {
        oldLines += 1;
        newLines += 1;
        lines.push(` ${op.line}`);
        continue;
      }

      if (op.type === "remove") {
        oldLines += 1;
        lines.push(`-${op.line}`);
        continue;
      }

      newLines += 1;
      lines.push(`+${op.line}`);
    }

    return {
      oldStart: startPosition.oldLine,
      oldLines,
      newStart: startPosition.newLine,
      newLines,
      lines
    };
  });
}

function buildPatchLinePositions(ops: LineDiffOp[]) {
  const positions: Array<{ oldLine: number; newLine: number }> = [];
  let oldLine = 1;
  let newLine = 1;

  for (const op of ops) {
    positions.push({ oldLine, newLine });

    if (op.type === "context") {
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (op.type === "remove") {
      oldLine += 1;
      continue;
    }

    newLine += 1;
  }

  return positions;
}

function collectChangedLineRanges(ops: LineDiffOp[]) {
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]?.type === "context") {
      continue;
    }

    const start = Math.max(0, index - HUNK_CONTEXT_LINE_COUNT);
    const end = Math.min(ops.length, index + HUNK_CONTEXT_LINE_COUNT + 1);
    const previous = ranges.at(-1);

    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      continue;
    }

    ranges.push({ start, end });
  }

  return ranges;
}

function buildTrailingNewlineOnlyHunks(
  oldContent: string,
  newContent: string,
  oldLines: readonly string[],
  newLines: readonly string[]
): StructuredPatchHunk[] {
  const oldEndsWithNewline = endsWithNewline(oldContent);
  const newEndsWithNewline = endsWithNewline(newContent);
  if (oldEndsWithNewline === newEndsWithNewline) {
    return [];
  }

  const oldStart = Math.max(1, oldLines.length);
  const newStart = Math.max(1, newLines.length);
  const oldLine = oldLines.at(-1) ?? "";
  const newLine = newLines.at(-1) ?? "";
  const noNewlineMarker = "\\ No newline at end of file";

  return [
    {
      oldStart,
      oldLines: oldLines.length > 0 ? 1 : 0,
      newStart,
      newLines: newLines.length > 0 ? 1 : 0,
      lines: oldEndsWithNewline
        ? [`-${oldLine}`, `+${newLine}`, noNewlineMarker]
        : [`-${oldLine}`, noNewlineMarker, `+${newLine}`]
    }
  ];
}

function formatHunkRange(start: number, count: number) {
  return `${start},${count}`;
}

function endsWithNewline(content: string) {
  return content.endsWith("\n") || content.endsWith("\r");
}
