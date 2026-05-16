import type { FileEdit } from "./types.js";

export interface ResolvedEditMatch {
  actualOldString: string;
  matchCount: number;
  strategy: string;
}

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

export function resolveEditMatch(
  fileContent: string,
  oldString: string,
  replaceAll: boolean
): ResolvedEditMatch {
  if (!oldString) {
    throw new Error("Edit requires a non-empty old_string");
  }

  for (const replacer of REPLACERS) {
    const candidates = findCandidatesForStrategy(replacer.find, fileContent, oldString);
    if (candidates.length === 0) {
      continue;
    }

    const totalMatches = candidates.reduce((sum, candidate) => sum + candidate.matchCount, 0);
    if (replaceAll && candidates.length === 1) {
      const candidate = candidates[0];
      return {
        actualOldString: candidate.text,
        matchCount: candidate.matchCount,
        strategy: replacer.strategy
      };
    }

    if (!replaceAll && totalMatches === 1 && candidates.length === 1) {
      const candidate = candidates[0];
      return {
        actualOldString: candidate.text,
        matchCount: candidate.matchCount,
        strategy: replacer.strategy
      };
    }

    throw new Error(
      replaceAll
        ? `Found multiple ${replacer.strategy} candidate variants. Provide an exact old_string or split the change into separate edits.`
        : `Found ${totalMatches} ${replacer.strategy} matches. Set replace_all=true or provide more unique old_string context.`
    );
  }

  throw new Error(
    "String to replace was not found in the target file. Edit tried exact, trimmed-line, block-anchor, whitespace-normalized, indentation-flexible, escaped-string, and trimmed-boundary matching."
  );
}

export function applyEditToFile(fileContent: string, edit: FileEdit): string {
  // replace_all=true 时做全量替换，否则只替换首个命中。
  return edit.replace_all
    ? fileContent.split(edit.old_string).join(edit.new_string)
    : fileContent.replace(edit.old_string, edit.new_string);
}

function countNonOverlappingMatches(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let matchCount = 0;
  let searchFrom = 0;

  while (searchFrom <= text.length) {
    const start = text.indexOf(needle, searchFrom);
    if (start === -1) {
      break;
    }

    matchCount += 1;
    searchFrom = start + needle.length;
  }

  return matchCount;
}

function findCandidatesForStrategy(replacer: Replacer, content: string, find: string) {
  const seen = new Set<string>();
  const candidates: Array<{ text: string; matchCount: number }> = [];
  for (const text of replacer(content, find)) {
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    const matchCount = countNonOverlappingMatches(content, text);
    if (matchCount > 0) {
      candidates.push({ text, matchCount });
    }
  }

  return candidates;
}

const REPLACERS: Array<{ strategy: string; find: Replacer }> = [
  { strategy: "exact", find: simpleReplacer },
  { strategy: "line-trimmed", find: lineTrimmedReplacer },
  { strategy: "block-anchor", find: blockAnchorReplacer },
  { strategy: "whitespace-normalized", find: whitespaceNormalizedReplacer },
  { strategy: "indentation-flexible", find: indentationFlexibleReplacer },
  { strategy: "escape-normalized", find: escapeNormalizedReplacer },
  { strategy: "trimmed-boundary", find: trimmedBoundaryReplacer }
];

function* simpleReplacer(_content: string, find: string) {
  yield find;
}

function* lineTrimmedReplacer(content: string, find: string) {
  const contentLines = content.split("\n");
  const findLines = trimTrailingEmptyLine(find.split("\n"));
  for (let index = 0; index <= contentLines.length - findLines.length; index += 1) {
    const block = contentLines.slice(index, index + findLines.length);
    if (block.every((line, offset) => line.trim() === findLines[offset].trim())) {
      yield block.join("\n");
    }
  }
}

function* blockAnchorReplacer(content: string, find: string) {
  const contentLines = content.split("\n");
  const findLines = trimTrailingEmptyLine(find.split("\n"));
  if (findLines.length < 3) {
    return;
  }

  const firstLine = findLines[0].trim();
  const lastLine = findLines[findLines.length - 1].trim();
  for (let start = 0; start < contentLines.length; start += 1) {
    if (contentLines[start].trim() !== firstLine) {
      continue;
    }

    for (let end = start + 2; end < contentLines.length; end += 1) {
      if (contentLines[end].trim() !== lastLine) {
        continue;
      }

      const block = contentLines.slice(start, end + 1);
      if (isSimilarAnchoredBlock(block, findLines, 0.5)) {
        yield block.join("\n");
      }
      break;
    }
  }
}

function* whitespaceNormalizedReplacer(content: string, find: string) {
  const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);
  const lines = content.split("\n");

  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    }
  }

  const findLines = find.split("\n");
  if (findLines.length <= 1) {
    return;
  }

  for (let index = 0; index <= lines.length - findLines.length; index += 1) {
    const block = lines.slice(index, index + findLines.length).join("\n");
    if (normalizeWhitespace(block) === normalizedFind) {
      yield block;
    }
  }
}

function* indentationFlexibleReplacer(content: string, find: string) {
  const normalizedFind = removeSharedIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let index = 0; index <= contentLines.length - findLines.length; index += 1) {
    const block = contentLines.slice(index, index + findLines.length).join("\n");
    if (removeSharedIndentation(block) === normalizedFind) {
      yield block;
    }
  }
}

function* escapeNormalizedReplacer(content: string, find: string) {
  const unescapedFind = unescapeCommonSequences(find);
  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let index = 0; index <= lines.length - findLines.length; index += 1) {
    const block = lines.slice(index, index + findLines.length).join("\n");
    if (unescapeCommonSequences(block) === unescapedFind) {
      yield block;
    }
  }
}

function* trimmedBoundaryReplacer(content: string, find: string) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) {
    return;
  }

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  for (let index = 0; index <= contentLines.length - findLines.length; index += 1) {
    const block = contentLines.slice(index, index + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
}

function trimTrailingEmptyLine(lines: string[]) {
  const result = [...lines];
  if (result.at(-1) === "") {
    result.pop();
  }

  return result;
}

function isSimilarAnchoredBlock(blockLines: string[], findLines: string[], threshold: number) {
  if (blockLines.length !== findLines.length) {
    return false;
  }

  let matchingLines = 0;
  let comparableLines = 0;
  for (let index = 1; index < blockLines.length - 1; index += 1) {
    const blockLine = blockLines[index].trim();
    const findLine = findLines[index].trim();
    if (blockLine.length === 0 && findLine.length === 0) {
      continue;
    }

    comparableLines += 1;
    if (blockLine === findLine) {
      matchingLines += 1;
    }
  }

  return comparableLines === 0 || matchingLines / comparableLines >= threshold;
}

function removeSharedIndentation(value: string) {
  const lines = value.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return value;
  }

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0)
  );
  return lines.map((line) =>
    line.trim().length === 0 ? line : line.slice(minIndent)
  ).join("\n");
}

function unescapeCommonSequences(value: string) {
  return value.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_match, captured: string) => {
    switch (captured) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "'":
        return "'";
      case "\"":
        return "\"";
      case "`":
        return "`";
      case "\\":
        return "\\";
      case "\n":
        return "\n";
      case "$":
        return "$";
      default:
        return captured;
    }
  });
}
