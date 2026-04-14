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
