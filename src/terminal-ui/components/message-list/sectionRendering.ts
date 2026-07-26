import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockTone
} from "../../state/types.js";
import { terminalUiTheme } from "../../theme/theme.js";
import { isDiffPatchBlock } from "../../utils/messageBlocks.js";
import { normalizeMarkdownInput } from "../../utils/htmlEntities.js";
import {
  advanceDiffPatchHunkTracker,
  countDiffPatchFileHeaders,
  createDiffPatchHunkTracker,
  isInsideDiffPatchHunk,
  parseDiffPatchHeaderPath,
  parseDiffPatchHunkHeader,
  setDiffPatchHunkTracker
} from "../../utils/diffPatchParsing.js";
import { wrapText } from "../../utils/text.js";
import type {
  DiffLineKind,
  MessagePalette,
  RenderedSection,
  RenderedSectionLine,
  ThemeColor
} from "./messageListTypes.js";

export const DIFF_LINE_NUMBER_LEFT_PADDING = "  ";
const DIFF_HUNK_SEPARATOR = "⋮";

function getToneColor(
  tone: TerminalUiMessageBlockTone,
  kind: TerminalUiMessage["kind"],
  palette: MessagePalette
) {
  if (kind === "system" && tone !== "danger") {
    return palette.bodyColor;
  }

  switch (tone) {
    case "muted":
      return palette.mutedColor;
    case "info":
      return terminalUiTheme.colors.info;
    case "success":
      return terminalUiTheme.colors.success;
    case "warning":
      return terminalUiTheme.colors.warning;
    case "danger":
      return terminalUiTheme.colors.danger;
    case "default":
    default:
      return kind === "thinking" ? palette.mutedColor : palette.bodyColor;
  }
}

export function renderSections(blocks: TerminalUiMessageBlock[], width: number): RenderedSection[] {
  const safeWidth = Math.max(12, width);
  return blocks.map((block) => buildRenderedSection(block, safeWidth));
}

function buildRenderedSection(block: TerminalUiMessageBlock, width: number): RenderedSection {
  return {
    label: block.label,
    lines: renderBlockLines(block, width),
    tone: block.tone ?? "default",
    style: block.style ?? "plain",
    isDiff: isDiffPatchBlock(block)
  };
}

export function renderBlockLines(block: TerminalUiMessageBlock, width: number): RenderedSectionLine[] {
  if (isDiffPatchBlock(block)) {
    return wrapDiffPatchLines(block.content, width);
  }

  return wrapText(normalizeMarkdownInput(block.content), width).map((content) => ({ content }));
}

function wrapDiffPatchLines(content: string, width: number): RenderedSectionLine[] {
  const parsedLines = parseDiffPatchLines(content);
  const lineNumberColumnWidth = parsedLines.reduce((maxWidth, line) => {
    return line.lineNumber === undefined
      ? maxWidth
      : Math.max(maxWidth, String(line.lineNumber).length);
  }, 0);
  const lineNumberGutterWidth = lineNumberColumnWidth > 0
    ? DIFF_LINE_NUMBER_LEFT_PADDING.length + lineNumberColumnWidth + 1
    : 0;
  const contentWidth = Math.max(8, width - lineNumberGutterWidth);

  return parsedLines.flatMap((parsedLine) => {
    const wrappedLines = wrapText(parsedLine.rawLine, contentWidth);

    return wrappedLines.map((line, index) => ({
      content: line,
      diffKind: parsedLine.diffKind,
      ...(lineNumberColumnWidth > 0
        ? {
            lineNumberText:
              index === 0 && parsedLine.lineNumber !== undefined
                ? String(parsedLine.lineNumber).padStart(lineNumberColumnWidth)
                : "".padStart(lineNumberColumnWidth)
          }
        : {})
    }));
  });
}

type ParsedDiffLine = {
  rawLine: string;
  diffKind?: DiffLineKind;
  lineNumber?: number;
};

function parseDiffPatchLines(content: string): ParsedDiffLine[] {
  const parsedLines: ParsedDiffLine[] = [];
  const rawLines = content.split(/\r?\n/);
  const showFileHeaders = countDiffPatchFileHeaders(rawLines, { stripGitPrefix: true }) > 1;
  let oldLine = 1;
  let newLine = 1;
  let hasHunk = false;
  let renderedLinesInCurrentHunk = 0;
  let pendingOldPath: string | undefined;
  const hunkTracker = createDiffPatchHunkTracker();

  for (const rawLine of rawLines) {
    const insideParsedHunk = isInsideDiffPatchHunk(hunkTracker);

    if (!insideParsedHunk && rawLine.startsWith("--- ")) {
      pendingOldPath = parseDiffPatchHeaderPath(rawLine, { stripGitPrefix: true });
      continue;
    }

    if (!insideParsedHunk && rawLine.startsWith("+++ ")) {
      const newPath = parseDiffPatchHeaderPath(rawLine, { stripGitPrefix: true });
      if (showFileHeaders) {
        appendDiffFileHeader(parsedLines, newPath ?? pendingOldPath);
        hasHunk = false;
        renderedLinesInCurrentHunk = 0;
        oldLine = 1;
        newLine = 1;
      }
      pendingOldPath = undefined;
      continue;
    }

    const diffKind = classifyDiffLine(rawLine, insideParsedHunk);
    if (diffKind === "meta") {
      continue;
    }

    if (diffKind === "hunk") {
      const hunk = parseDiffPatchHunkHeader(rawLine);
      if (hunk) {
        if (renderedLinesInCurrentHunk > 0) {
          parsedLines.push({
            rawLine: DIFF_HUNK_SEPARATOR,
            diffKind: "separator"
          });
        }
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
        hasHunk = true;
        renderedLinesInCurrentHunk = 0;
        setDiffPatchHunkTracker(hunkTracker, hunk);
      }
      continue;
    }

    if (!hasHunk && (diffKind === "add" || diffKind === "remove" || diffKind === "context")) {
      oldLine = 1;
      newLine = 1;
      hasHunk = true;
    }

    if (diffKind === "add") {
      parsedLines.push({
        rawLine,
        diffKind,
        lineNumber: newLine
      });
      newLine += 1;
      renderedLinesInCurrentHunk += 1;
      advanceDiffPatchHunkTracker(hunkTracker, rawLine);
      continue;
    }

    if (diffKind === "remove") {
      parsedLines.push({
        rawLine,
        diffKind,
        lineNumber: oldLine
      });
      oldLine += 1;
      renderedLinesInCurrentHunk += 1;
      advanceDiffPatchHunkTracker(hunkTracker, rawLine);
      continue;
    }

    if (diffKind === "context") {
      parsedLines.push({
        rawLine,
        diffKind,
        lineNumber: newLine
      });
      oldLine += 1;
      newLine += 1;
      renderedLinesInCurrentHunk += 1;
      advanceDiffPatchHunkTracker(hunkTracker, rawLine);
      continue;
    }

    parsedLines.push({
      rawLine,
      diffKind
    });
  }

  return parsedLines;
}

function appendDiffFileHeader(parsedLines: ParsedDiffLine[], filePath: string | undefined) {
  if (!filePath) {
    return;
  }

  if (parsedLines.length > 0) {
    parsedLines.push({
      rawLine: "",
      diffKind: "separator"
    });
  }

  parsedLines.push({
    rawLine: filePath,
    diffKind: "file"
  });
}

function classifyDiffLine(line: string, insideHunk = false): DiffLineKind | undefined {
  if (
    (!insideHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  ) {
    return "meta";
  }

  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (line.startsWith("+")) {
    return "add";
  }

  if (line.startsWith("-")) {
    return "remove";
  }

  if (line.startsWith(" ")) {
    return "context";
  }

  return undefined;
}

export function getRenderedLineColors(
  line: RenderedSectionLine,
  section: RenderedSection,
  messageKind: TerminalUiMessage["kind"],
  palette: MessagePalette
): {
  color: ThemeColor;
  backgroundColor?: ThemeColor;
} {
  switch (line.diffKind) {
    case "add":
      return {
        color: terminalUiTheme.colors.diffAdded,
        backgroundColor: terminalUiTheme.colors.diffAddedBackground
      };
    case "remove":
      return {
        color: terminalUiTheme.colors.diffRemoved,
        backgroundColor: terminalUiTheme.colors.diffRemovedBackground
      };
    case "meta":
      return {
        color: terminalUiTheme.colors.diffMeta
      };
    case "hunk":
      return {
        color: terminalUiTheme.colors.diffHunk
      };
    case "file":
      return {
        color: terminalUiTheme.colors.diffMeta
      };
    case "separator":
      return {
        color: terminalUiTheme.colors.subtle
      };
    case "context":
      return {
        color: terminalUiTheme.colors.code
      };
    default:
      return {
        color:
          section.style === "code"
            ? messageKind === "system"
              ? palette.bodyColor
              : messageKind === "tool"
                ? palette.bodyColor
                : terminalUiTheme.colors.code
            : getToneColor(section.tone, messageKind, palette)
      };
  }
}

export function shouldDisplaySectionLabel(section: RenderedSection) {
  return Boolean(section.label) && !section.isDiff;
}

export function countRenderedSectionRows(sections: RenderedSection[]) {
  return sections.reduce((sum, section) => {
    return sum + section.lines.length + (shouldDisplaySectionLabel(section) ? 1 : 0);
  }, 0);
}
