import { normalizeMarkdownInput } from "../../utils/htmlEntities.js";
import { measureCharWidth } from "../../utils/text.js";
import type {
  MarkdownCharacter,
  MarkdownLineVariant,
  MarkdownRenderBlock,
  MarkdownRenderLine,
  MarkdownSpan,
  MarkdownSpanStyle
} from "./types.js";

export function createWrappedSpanBlock(
  spans: MarkdownSpan[],
  width: number,
  options: {
    key: string;
    indent: number;
    prefixFirst?: string;
    prefixRest?: string;
    variant: MarkdownLineVariant;
  }
): MarkdownRenderBlock {
  return {
    key: options.key,
    marginTop: 0,
    lines: wrapSpans(spans, width, {
      key: options.key,
      indent: options.indent,
      prefixFirst: options.prefixFirst ?? "",
      prefixRest:
        options.prefixRest ??
        " ".repeat(measureStringWidth(options.prefixFirst ?? "")),
      variant: options.variant
    })
  };
}

export function wrapSpans(
  spans: MarkdownSpan[],
  width: number,
  options: {
    key: string;
    indent: number;
    prefixFirst?: string;
    prefixRest?: string;
    variant: MarkdownLineVariant;
  }
): MarkdownRenderLine[] {
  const prefixFirst = options.prefixFirst ?? "";
  const prefixRest = options.prefixRest ?? "";
  const characters = spansToCharacters(spans);
  const lines: MarkdownCharacter[][] = [];
  let currentLine: MarkdownCharacter[] = [];
  let currentWidth = 0;
  let lineIndex = 0;

  const getAvailableWidth = (index: number) =>
    Math.max(
      1,
      width -
        options.indent -
        measureStringWidth(index === 0 ? prefixFirst : prefixRest)
    );

  const pushLine = () => {
    lines.push(currentLine);
    currentLine = [];
    currentWidth = 0;
    lineIndex += 1;
  };

  if (characters.length === 0) {
    return [
      {
        key: `${options.key}-0`,
        indent: options.indent,
        prefix: prefixFirst,
        spans: [{ text: " " }],
        variant: options.variant
      }
    ];
  }

  for (const character of characters) {
    if (character.char === "\n") {
      pushLine();
      continue;
    }

    const nextWidth = measureCharWidth(character.char);
    const availableWidth = getAvailableWidth(lineIndex);

    if (currentLine.length > 0 && currentWidth + nextWidth > availableWidth) {
      pushLine();
    }

    currentLine.push(character);
    currentWidth += nextWidth;
  }

  lines.push(currentLine);

  return lines.map((charactersInLine, index) => ({
    key: `${options.key}-${index}`,
    indent: options.indent,
    prefix: index === 0 ? prefixFirst : prefixRest,
    spans: charactersToSpans(charactersInLine),
    variant: options.variant
  }));
}

export function applySpanStyle(spans: MarkdownSpan[], style: MarkdownSpanStyle): MarkdownSpan[] {
  return spans.map((span) => ({
    ...span,
    ...style
  }));
}

export function mergeAdjacentSpans(spans: MarkdownSpan[]): MarkdownSpan[] {
  const merged: MarkdownSpan[] = [];

  for (const span of spans) {
    const last = merged.at(-1);
    if (!last || !isSameSpanStyle(last, span)) {
      merged.push({ ...span });
      continue;
    }

    last.text += span.text;
  }

  return merged;
}

function spansToCharacters(spans: MarkdownSpan[]): MarkdownCharacter[] {
  const characters: MarkdownCharacter[] = [];

  for (const span of spans) {
    for (const character of Array.from(span.text)) {
      characters.push({
        char: character,
        color: span.color,
        href: span.href,
        bold: span.bold,
        italic: span.italic,
        underline: span.underline,
        dim: span.dim,
        strikethrough: span.strikethrough
      });
    }
  }

  return characters;
}

function charactersToSpans(characters: MarkdownCharacter[]): MarkdownSpan[] {
  if (characters.length === 0) {
    return [{ text: " " }];
  }

  const spans: MarkdownSpan[] = [];

  for (const character of characters) {
    const last = spans.at(-1);
    if (!last || !isSameSpanStyle(last, character)) {
      spans.push({
        text: character.char,
        color: character.color,
        href: character.href,
        bold: character.bold,
        italic: character.italic,
        underline: character.underline,
        dim: character.dim,
        strikethrough: character.strikethrough
      });
      continue;
    }

    last.text += character.char;
  }

  return spans;
}

function isSameSpanStyle(
  left: MarkdownSpanStyle,
  right: MarkdownSpanStyle
): boolean {
  return (
    left.color === right.color &&
    left.href === right.href &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.dim === right.dim &&
    left.strikethrough === right.strikethrough
  );
}

export function measureSpansWidth(spans: MarkdownSpan[]): number {
  return spans.reduce((sum, span) => sum + measureStringWidth(span.text), 0);
}

export function measureStringWidth(value: string): number {
  return Array.from(value).reduce((sum, character) => sum + measureCharWidth(character), 0);
}

export function normalizeInlineMarkdownText(value: string): string {
  return normalizeMarkdownInput(value, { normalizeLineEndings: false });
}
