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
  const hunks: StructuredPatchHunk[] = [];
  let currentHunk: StructuredPatchHunk | null = null;
  let oldLine = 1;
  let newLine = 1;

  const flushHunk = () => {
    if (!currentHunk) {
      return;
    }

    hunks.push(currentHunk);
    currentHunk = null;
  };

  for (const op of ops) {
    if (op.type === "context") {
      flushHunk();
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (!currentHunk) {
      currentHunk = {
        oldStart: oldLine,
        oldLines: 0,
        newStart: newLine,
        newLines: 0,
        lines: []
      };
    }

    if (op.type === "remove") {
      currentHunk.oldLines += 1;
      currentHunk.lines.push(`-${op.line}`);
      oldLine += 1;
      continue;
    }

    currentHunk.newLines += 1;
    currentHunk.lines.push(`+${op.line}`);
    newLine += 1;
  }

  flushHunk();
  return hunks;
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
