import type { FileEdit } from "./types.js";

export function applyEditToFile(fileContent: string, edit: FileEdit): string {
  // replace_all=true 时做全量替换，否则只替换首个命中。
  return edit.replace_all
    ? fileContent.split(edit.old_string).join(edit.new_string)
    : fileContent.replace(edit.old_string, edit.new_string);
}

export function getPatchForEdit(options: {
  filePath: string;
  fileContents: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}) {
  const edit: FileEdit = {
    old_string: options.oldString,
    new_string: options.newString,
    replace_all: Boolean(options.replaceAll)
  };

  const updatedFile = applyEditToFile(options.fileContents, edit);
  const lineMap = buildLineMap(options.fileContents);
  const matches = findNonOverlappingMatches(options.fileContents, options.oldString);
  const groupedMatches = groupMatchesByTouchedLines(
    matches
      .slice(0, edit.replace_all ? matches.length : 1)
      .map((match) => ({
        ...match,
        startLine: findLineIndexAtPosition(lineMap.starts, match.start),
        endLine: findLineIndexAtPosition(lineMap.starts, Math.max(match.start, match.end - 1))
      }))
  );

  let lineDelta = 0;
  const patch = groupedMatches.map((group, index) => {
    const oldSegment = sliceRawLineRange(
      options.fileContents,
      lineMap,
      group.startLine,
      group.endLine
    );
    const newSegment = applyGroupedReplacements(
      oldSegment,
      group.matches,
      group.startOffset,
      options.newString
    );
    const oldLines = extractLineRange(options.fileContents, lineMap, group.startLine, group.endLine);
    const newLines = splitLines(newSegment);
    const oldStart = group.startLine + 1;
    const newStart = oldStart + lineDelta;

    lineDelta += newLines.length - oldLines.length;

    return {
      oldStart,
      oldLines: oldLines.length,
      newStart,
      newLines: newLines.length,
      lines: [
        ...(index === 0 ? [`--- ${options.filePath}`, `+++ ${options.filePath}`] : []),
        `@@ -${formatHunkRange(oldStart, oldLines.length)} +${formatHunkRange(newStart, newLines.length)} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`)
      ]
    };
  });

  return { patch, updatedFile };
}

type Match = {
  start: number;
  end: number;
};

type LineMappedMatch = Match & {
  startLine: number;
  endLine: number;
};

type MatchGroup = {
  matches: LineMappedMatch[];
  startLine: number;
  endLine: number;
  startOffset: number;
};

type LineMap = {
  starts: number[];
  contentEnds: number[];
  fullEnds: number[];
};

function findNonOverlappingMatches(text: string, needle: string): Match[] {
  if (!needle) {
    return [];
  }

  const matches: Match[] = [];
  let searchFrom = 0;

  while (searchFrom <= text.length) {
    const start = text.indexOf(needle, searchFrom);
    if (start === -1) {
      break;
    }

    matches.push({
      start,
      end: start + needle.length
    });
    searchFrom = start + needle.length;
  }

  return matches;
}

function groupMatchesByTouchedLines(matches: LineMappedMatch[]): MatchGroup[] {
  if (matches.length === 0) {
    return [];
  }

  const groups: MatchGroup[] = [];

  for (const match of matches) {
    const previous = groups.at(-1);
    if (!previous || match.startLine > previous.endLine + 1) {
      groups.push({
        matches: [match],
        startLine: match.startLine,
        endLine: match.endLine,
        startOffset: match.start
      });
      continue;
    }

    previous.matches.push(match);
    previous.endLine = Math.max(previous.endLine, match.endLine);
  }

  return groups;
}

function buildLineMap(text: string): LineMap {
  if (text.length === 0) {
    return {
      starts: [0],
      contentEnds: [0],
      fullEnds: [0]
    };
  }

  const starts = [0];
  const contentEnds: number[] = [];
  const fullEnds: number[] = [];
  const newlinePattern = /\r?\n/g;
  let match: RegExpExecArray | null;

  while ((match = newlinePattern.exec(text)) !== null) {
    contentEnds.push(match.index);
    fullEnds.push(match.index + match[0].length);
    starts.push(match.index + match[0].length);
  }

  contentEnds.push(text.length);
  fullEnds.push(text.length);

  if (text.endsWith("\n")) {
    starts.pop();
    contentEnds.pop();
    fullEnds.pop();
  }

  return {
    starts,
    contentEnds,
    fullEnds
  };
}

function findLineIndexAtPosition(lineStarts: number[], position: number) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle] ?? 0;
    if (start <= position) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return Math.max(0, high);
}

function sliceRawLineRange(
  text: string,
  lineMap: LineMap,
  startLine: number,
  endLine: number
) {
  return text.slice(lineMap.starts[startLine] ?? 0, lineMap.fullEnds[endLine] ?? text.length);
}

function extractLineRange(
  text: string,
  lineMap: LineMap,
  startLine: number,
  endLine: number
) {
  const lines: string[] = [];

  for (let line = startLine; line <= endLine; line += 1) {
    lines.push(text.slice(lineMap.starts[line] ?? 0, lineMap.contentEnds[line] ?? text.length));
  }

  return lines;
}

function applyGroupedReplacements(
  originalSegment: string,
  matches: LineMappedMatch[],
  segmentStartOffset: number,
  replacement: string
) {
  let result = "";
  let cursor = 0;

  for (const match of matches) {
    const relativeStart = match.start - segmentStartOffset;
    const relativeEnd = match.end - segmentStartOffset;
    result += originalSegment.slice(cursor, relativeStart);
    result += replacement;
    cursor = relativeEnd;
  }

  result += originalSegment.slice(cursor);
  return result;
}

function splitLines(text: string) {
  if (text.length === 0) {
    return [];
  }

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function formatHunkRange(start: number, count: number) {
  return `${start},${count}`;
}
