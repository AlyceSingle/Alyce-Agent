import {
  createStructuredPatch as createLineStructuredPatch,
  type StructuredPatchHunk
} from "./structuredPatch.js";

export type ApplyPatchOperation =
  | { type: "add"; path: string; contents: string; additions: number }
  | { type: "delete"; path: string }
  | {
      type: "update";
      path: string;
      movePath?: string;
      chunks: ApplyPatchUpdateChunk[];
    };

export interface ApplyPatchUpdateChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  isEndOfFile: boolean;
  additions: number;
  deletions: number;
}

const UNIFIED_DIFF_RANGE_CONTEXT = /^-\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?:\s*(.*))?$/;

export type ApplyPatchStructuredPatchHunk = StructuredPatchHunk;

export interface PatchedContentResult {
  content: string;
  matchStrategies: string[];
  additions: number;
  deletions: number;
}

interface Replacement {
  startIndex: number;
  deleteCount: number;
  newLines: string[];
}

interface SeekMatch {
  index: number;
  strategy: string;
}

type Comparator = (actual: string, expected: string) => boolean;

export function parseApplyPatch(patchText: string): ApplyPatchOperation[] {
  const cleaned = stripHeredoc(patchText).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = cleaned.split("\n");
  const beginIndex = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const endIndex =
    beginIndex === -1
      ? -1
      : lines.findIndex((line, index) => index > beginIndex && line.trim() === "*** End Patch");

  if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const operations: ApplyPatchOperation[] = [];
  let index = beginIndex + 1;
  while (index < endIndex) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File:")) {
      const filePath = parsePathHeader(line, "*** Add File:", index);
      const parsed = parseAddFile(lines, index + 1, endIndex);
      operations.push({
        type: "add",
        path: filePath,
        contents: parsed.contents,
        additions: parsed.additions
      });
      index = parsed.nextIndex;
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      operations.push({
        type: "delete",
        path: parsePathHeader(line, "*** Delete File:", index)
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const filePath = parsePathHeader(line, "*** Update File:", index);
      index += 1;
      let movePath: string | undefined;
      if (index < endIndex && lines[index].startsWith("*** Move to:")) {
        movePath = parsePathHeader(lines[index], "*** Move to:", index);
        index += 1;
      }

      const parsed = parseUpdateFile(lines, index, endIndex);
      if (parsed.chunks.length === 0 && !movePath) {
        throw new Error(`Update File requires at least one @@ hunk: ${filePath}`);
      }

      operations.push({
        type: "update",
        path: filePath,
        movePath,
        chunks: parsed.chunks
      });
      index = parsed.nextIndex;
      continue;
    }

    throw new Error(`Invalid patch operation at line ${index + 1}: ${line}`);
  }

  return operations;
}

export function derivePatchedContent(
  filePath: string,
  originalContent: string,
  chunks: readonly ApplyPatchUpdateChunk[]
): PatchedContentResult {
  const originalLines = splitPatchLines(originalContent);
  const replacements: Replacement[] = [];
  const matchStrategies: string[] = [];
  let lineIndex = 0;
  let additions = 0;
  let deletions = 0;

  for (const chunk of chunks) {
    additions += chunk.additions;
    deletions += chunk.deletions;

    if (chunk.changeContext) {
      const contextMatch = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (!contextMatch) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }

      matchStrategies.push(`context:${contextMatch.strategy}`);
      lineIndex = contextMatch.index + 1;
    }

    if (chunk.oldLines.length === 0) {
      if (chunk.newLines.length === 0) {
        throw new Error(`Empty update hunk in ${filePath}`);
      }

      const insertionIndex = chunk.changeContext ? lineIndex : originalLines.length;
      replacements.push({
        startIndex: insertionIndex,
        deleteCount: 0,
        newLines: chunk.newLines
      });
      lineIndex = insertionIndex;
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let match = seekSequence(originalLines, oldLines, lineIndex, chunk.isEndOfFile);

    if (!match && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      newLines = newLines.at(-1) === "" ? newLines.slice(0, -1) : newLines;
      match = seekSequence(originalLines, oldLines, lineIndex, chunk.isEndOfFile);
    }

    if (!match) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
    }

    matchStrategies.push(match.strategy);
    replacements.push({
      startIndex: match.index,
      deleteCount: oldLines.length,
      newLines
    });
    lineIndex = match.index + oldLines.length;
  }

  const nextLines = applyReplacements(originalLines, replacements);
  if (nextLines.length === 0 || nextLines.at(-1) !== "") {
    nextLines.push("");
  }

  return {
    content: nextLines.join("\n"),
    matchStrategies: [...new Set(matchStrategies)],
    additions,
    deletions
  };
}

export function ensureTrailingNewline(content: string) {
  return content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
}

export function createStructuredPatch(options: {
  filePath?: string;
  oldContent: string;
  newContent: string;
}): ApplyPatchStructuredPatchHunk[] {
  return createLineStructuredPatch({
    filePath: options.filePath,
    oldContent: options.oldContent,
    newContent: options.newContent,
    includeFileHeader: Boolean(options.filePath)
  });
}

export function splitPatchLines(content: string) {
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

function parseAddFile(lines: readonly string[], startIndex: number, endIndex: number) {
  const contentLines: string[] = [];
  let index = startIndex;
  while (index < endIndex && !isFileOperationHeader(lines[index])) {
    const line = lines[index];
    if (!line.startsWith("+")) {
      throw new Error(`Add File content lines must start with '+': line ${index + 1}`);
    }

    contentLines.push(line.slice(1));
    index += 1;
  }

  return {
    contents: contentLines.join("\n"),
    additions: contentLines.length,
    nextIndex: index
  };
}

function parseUpdateFile(lines: readonly string[], startIndex: number, endIndex: number) {
  const chunks: ApplyPatchUpdateChunk[] = [];
  let index = startIndex;
  let parsedAnyChunk = false;

  while (index < endIndex && !isFileOperationHeader(lines[index])) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (!parsedAnyChunk && isUnifiedDiffFileHeader(line)) {
      index += 1;
      continue;
    }

    if (!line.startsWith("@@")) {
      throw new Error(`Expected @@ hunk header at line ${index + 1}: ${line}`);
    }

    const context = normalizeChangeContext(line.slice(2).trim());
    index += 1;

    const oldLines: string[] = [];
    const newLines: string[] = [];
    let additions = 0;
    let deletions = 0;
    let isEndOfFile = false;

    while (index < endIndex && !lines[index].startsWith("@@") && !isFileOperationHeader(lines[index])) {
      const changeLine = lines[index];
      if (changeLine === "*** End of File") {
        isEndOfFile = true;
        index += 1;
        break;
      }

      if (changeLine.startsWith(" ")) {
        const content = changeLine.slice(1);
        oldLines.push(content);
        newLines.push(content);
      } else if (changeLine.startsWith("-")) {
        oldLines.push(changeLine.slice(1));
        deletions += 1;
      } else if (changeLine.startsWith("+")) {
        newLines.push(changeLine.slice(1));
        additions += 1;
      } else if (changeLine.trim().length !== 0) {
        throw new Error(`Invalid hunk line at line ${index + 1}: ${changeLine}`);
      }

      index += 1;
    }

    if (oldLines.length === 0 && newLines.length === 0) {
      throw new Error(`Empty update hunk at line ${index + 1}`);
    }

    chunks.push({
      oldLines,
      newLines,
      changeContext: context || undefined,
      isEndOfFile,
      additions,
      deletions
    });
    parsedAnyChunk = true;
  }

  return { chunks, nextIndex: index };
}

function normalizeChangeContext(context: string) {
  const match = context.match(UNIFIED_DIFF_RANGE_CONTEXT);
  return match ? (match[1] ?? "").trim() : context;
}

function isUnifiedDiffFileHeader(line: string) {
  return line.startsWith("--- ") || line.startsWith("+++ ");
}

function parsePathHeader(line: string, prefix: string, index: number) {
  const filePath = line.slice(prefix.length).trim();
  if (!filePath) {
    throw new Error(`Missing path at line ${index + 1}`);
  }

  return filePath;
}

function stripHeredoc(input: string) {
  const normalized = input.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = normalized.match(
    /^(?:(?:apply_patch|cat)\s+)?<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n([\s\S]*?)\n\1\s*$/
  );
  return match ? match[2] : normalized;
}

function isFileOperationHeader(line: string) {
  return (
    line.startsWith("*** Add File:") ||
    line.startsWith("*** Delete File:") ||
    line.startsWith("*** Update File:")
  );
}

function applyReplacements(lines: readonly string[], replacements: readonly Replacement[]) {
  const result: string[] = [];
  const sorted = [...replacements].sort((left, right) => left.startIndex - right.startIndex);
  let cursor = 0;
  for (const replacement of sorted) {
    if (replacement.startIndex < cursor) {
      throw new Error("Overlapping update hunks are not supported");
    }

    result.push(...lines.slice(cursor, replacement.startIndex));
    result.push(...replacement.newLines);
    cursor = replacement.startIndex + replacement.deleteCount;
  }

  result.push(...lines.slice(cursor));
  return result;
}

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  endOfFile: boolean
): SeekMatch | null {
  if (pattern.length === 0) {
    return null;
  }

  const strategies: Array<{ name: string; compare: Comparator }> = [
    { name: "exact", compare: (actual, expected) => actual === expected },
    {
      name: "trailing-whitespace-trimmed",
      compare: (actual, expected) => actual.trimEnd() === expected.trimEnd()
    },
    {
      name: "trimmed",
      compare: (actual, expected) => actual.trim() === expected.trim()
    },
    {
      name: "unicode-normalized",
      compare: (actual, expected) =>
        normalizeUnicodePunctuation(actual.trim()) === normalizeUnicodePunctuation(expected.trim())
    }
  ];

  for (const strategy of strategies) {
    const index = tryMatch(lines, pattern, startIndex, strategy.compare, endOfFile);
    if (index !== -1) {
      return { index, strategy: strategy.name };
    }
  }

  return null;
}

function tryMatch(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  compare: Comparator,
  endOfFile: boolean
) {
  if (endOfFile) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && matchesAt(lines, pattern, fromEnd, compare)) {
      return fromEnd;
    }
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    if (matchesAt(lines, pattern, index, compare)) {
      return index;
    }
  }

  return -1;
}

function matchesAt(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  compare: Comparator
) {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (!compare(lines[startIndex + offset] ?? "", pattern[offset] ?? "")) {
      return false;
    }
  }

  return true;
}

function normalizeUnicodePunctuation(value: string) {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}
