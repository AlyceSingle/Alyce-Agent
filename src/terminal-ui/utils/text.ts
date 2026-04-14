export function measureCharWidth(character: string): number {
  if (character.length === 0) {
    return 0;
  }

  return /[^\u0000-\u00ff]/.test(character) ? 2 : 1;
}

function toCharacters(value: string): string[] {
  return Array.from(value);
}

function takeSuffixByDisplayWidth(
  characters: string[],
  endExclusive: number,
  maxWidth: number
): { text: string; startIndex: number; width: number } {
  let width = 0;
  let startIndex = endExclusive;

  while (startIndex > 0) {
    const nextWidth = measureCharWidth(characters[startIndex - 1] ?? "");
    if (width + nextWidth > maxWidth) {
      break;
    }

    startIndex -= 1;
    width += nextWidth;
  }

  return {
    text: characters.slice(startIndex, endExclusive).join(""),
    startIndex,
    width
  };
}

function takePrefixByDisplayWidth(
  characters: string[],
  startIndex: number,
  maxWidth: number
): { text: string; endIndex: number; width: number } {
  let width = 0;
  let endIndex = startIndex;

  while (endIndex < characters.length) {
    const nextWidth = measureCharWidth(characters[endIndex] ?? "");
    if (width + nextWidth > maxWidth) {
      break;
    }

    width += nextWidth;
    endIndex += 1;
  }

  return {
    text: characters.slice(startIndex, endIndex).join(""),
    endIndex,
    width
  };
}

export function buildInputViewport(value: string, cursor: number, maxWidth: number) {
  const safeWidth = Math.max(8, maxWidth);
  const characters = toCharacters(value);
  const safeCursor = Math.min(Math.max(0, cursor), characters.length);

  if (characters.length === 0) {
    return {
      before: "",
      current: " ",
      after: "",
      hasLeftOverflow: false,
      hasRightOverflow: false
    };
  }

  if (safeCursor >= characters.length) {
    const visibleBefore = takeSuffixByDisplayWidth(characters, characters.length, safeWidth - 1);
    return {
      before: visibleBefore.text,
      current: " ",
      after: "",
      hasLeftOverflow: visibleBefore.startIndex > 0,
      hasRightOverflow: false
    };
  }

  const current = characters[safeCursor] ?? " ";
  const currentWidth = measureCharWidth(current);
  const remainingWidth = Math.max(0, safeWidth - currentWidth);
  const leftBudget = Math.floor(remainingWidth / 2);
  const rightBudget = remainingWidth - leftBudget;

  const beforePart = takeSuffixByDisplayWidth(characters, safeCursor, leftBudget);
  const afterPart = takePrefixByDisplayWidth(characters, safeCursor + 1, rightBudget);

  return {
    before: beforePart.text,
    current,
    after: afterPart.text,
    hasLeftOverflow: beforePart.startIndex > 0,
    hasRightOverflow: afterPart.endIndex < characters.length
  };
}

type WrappedInputLine = {
  chars: string[];
  startIndex: number;
  endIndex: number;
};

export interface InputViewportLine {
  before: string;
  current: string | null;
  after: string;
  isCursorLine: boolean;
}

function wrapInputLines(value: string, width: number): WrappedInputLine[] {
  const safeWidth = Math.max(8, width);
  const characters = toCharacters(value);
  const lines: WrappedInputLine[] = [];
  let currentChars: string[] = [];
  let currentWidth = 0;
  let lineStartIndex = 0;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";

    if (character === "\n") {
      lines.push({
        chars: currentChars,
        startIndex: lineStartIndex,
        endIndex: index
      });
      currentChars = [];
      currentWidth = 0;
      lineStartIndex = index + 1;
      continue;
    }

    const nextWidth = measureCharWidth(character);
    if (currentChars.length > 0 && currentWidth + nextWidth > safeWidth) {
      lines.push({
        chars: currentChars,
        startIndex: lineStartIndex,
        endIndex: index
      });
      currentChars = [character];
      currentWidth = nextWidth;
      lineStartIndex = index;
      continue;
    }

    currentChars.push(character);
    currentWidth += nextWidth;
  }

  lines.push({
    chars: currentChars,
    startIndex: lineStartIndex,
    endIndex: characters.length
  });

  return lines;
}

function getCursorLineLocation(lines: WrappedInputLine[], cursor: number) {
  if (lines.length === 0) {
    return {
      lineIndex: 0,
      column: 0
    };
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextLine = lines[index + 1];
    const wrapsIntoNextLine =
      nextLine !== undefined &&
      cursor === line.endIndex &&
      nextLine.startIndex === cursor &&
      nextLine.startIndex === line.endIndex;

    if (cursor < line.startIndex || cursor > line.endIndex || wrapsIntoNextLine) {
      continue;
    }

    return {
      lineIndex: index,
      column: cursor - line.startIndex
    };
  }

  const lastLine = lines.at(-1)!;
  return {
    lineIndex: lines.length - 1,
    column: Math.max(0, cursor - lastLine.startIndex)
  };
}

export function buildInputEditorViewport(
  value: string,
  cursor: number,
  maxWidth: number,
  maxLines: number
): {
  lines: InputViewportLine[];
  hasTopOverflow: boolean;
  hasBottomOverflow: boolean;
  totalLines: number;
} {
  const safeWidth = Math.max(8, maxWidth);
  const safeMaxLines = Math.max(1, maxLines);
  const characters = toCharacters(value);
  const safeCursor = Math.min(Math.max(0, cursor), characters.length);
  const wrappedLines = wrapInputLines(value, safeWidth);
  const cursorLocation = getCursorLineLocation(wrappedLines, safeCursor);
  const startLine = Math.max(0, cursorLocation.lineIndex - safeMaxLines + 1);
  const endLine = Math.min(wrappedLines.length, startLine + safeMaxLines);
  const visibleLines = wrappedLines.slice(startLine, endLine);

  return {
    lines: visibleLines.map((line, index) => {
      const absoluteLineIndex = startLine + index;

      if (absoluteLineIndex !== cursorLocation.lineIndex) {
        return {
          before: line.chars.join(""),
          current: null,
          after: "",
          isCursorLine: false
        };
      }

      const before = line.chars.slice(0, cursorLocation.column).join("");
      if (cursorLocation.column >= line.chars.length) {
        return {
          before,
          current: " ",
          after: "",
          isCursorLine: true
        };
      }

      return {
        before,
        current: line.chars[cursorLocation.column] ?? " ",
        after: line.chars.slice(cursorLocation.column + 1).join(""),
        isCursorLine: true
      };
    }),
    hasTopOverflow: startLine > 0,
    hasBottomOverflow: endLine < wrappedLines.length,
    totalLines: wrappedLines.length
  };
}

export function moveCursorVertically(
  value: string,
  cursor: number,
  width: number,
  delta: -1 | 1
): number {
  const wrappedLines = wrapInputLines(value, width);
  const cursorLocation = getCursorLineLocation(wrappedLines, cursor);
  const targetLineIndex = Math.max(
    0,
    Math.min(wrappedLines.length - 1, cursorLocation.lineIndex + delta)
  );
  const targetLine = wrappedLines[targetLineIndex]!;
  return targetLine.startIndex + Math.min(cursorLocation.column, targetLine.chars.length);
}

export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  const lines = value.split(/\r?\n/);
  const wrapped: string[] = [];

  for (const rawLine of lines) {
    if (rawLine.length === 0) {
      wrapped.push("");
      continue;
    }

    let currentLine = "";
    let currentWidth = 0;
    for (const character of rawLine) {
      const charWidth = measureCharWidth(character);
      if (currentWidth + charWidth > safeWidth && currentLine.length > 0) {
        wrapped.push(currentLine);
        currentLine = character;
        currentWidth = charWidth;
        continue;
      }

      currentLine += character;
      currentWidth += charWidth;
    }

    wrapped.push(currentLine);
  }

  return wrapped;
}

export function wrapTextClamped(
  value: string,
  width: number,
  maxLines: number
): { lines: string[]; truncated: boolean } {
  const safeWidth = Math.max(8, width);
  const safeMaxLines = Math.max(1, maxLines);
  const rawLines = value.split(/\r?\n/);
  const wrapped: string[] = [];

  const finalizeTruncated = () => ({
    lines: [...wrapped.slice(0, Math.max(0, safeMaxLines - 1)), "..."],
    truncated: true
  });

  for (let rawLineIndex = 0; rawLineIndex < rawLines.length; rawLineIndex += 1) {
    const rawLine = rawLines[rawLineIndex] ?? "";

    if (rawLine.length === 0) {
      wrapped.push("");
      if (wrapped.length >= safeMaxLines) {
        const hasMoreContent = rawLineIndex < rawLines.length - 1;
        return hasMoreContent ? finalizeTruncated() : { lines: wrapped, truncated: false };
      }
      continue;
    }

    let currentLine = "";
    let currentWidth = 0;
    for (let characterIndex = 0; characterIndex < rawLine.length; characterIndex += 1) {
      const character = rawLine[characterIndex] ?? "";
      const charWidth = measureCharWidth(character);
      if (currentWidth + charWidth > safeWidth && currentLine.length > 0) {
        wrapped.push(currentLine);
        if (wrapped.length >= safeMaxLines) {
          return finalizeTruncated();
        }

        currentLine = character;
        currentWidth = charWidth;
        continue;
      }

      currentLine += character;
      currentWidth += charWidth;
    }

    wrapped.push(currentLine);
    if (wrapped.length >= safeMaxLines) {
      const hasMoreContent = rawLineIndex < rawLines.length - 1;
      return hasMoreContent ? finalizeTruncated() : { lines: wrapped, truncated: false };
    }
  }

  return {
    lines: wrapped,
    truncated: false
  };
}

export function clampLines(lines: string[], maxLines: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= maxLines) {
    return {
      lines,
      truncated: false
    };
  }

  return {
    lines: [...lines.slice(0, Math.max(0, maxLines - 1)), "..."],
    truncated: true
  };
}

export function summarizeText(value: string, width: number, maxLines: number): string[] {
  return clampLines(wrapText(value, width), maxLines).lines;
}

export function normalizeInlineValue(value: string | undefined, fallback = "Not set"): string {
  if (!value) {
    return fallback;
  }

  return value.replace(/\r?\n/g, "\\n");
}
