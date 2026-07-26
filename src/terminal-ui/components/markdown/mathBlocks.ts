import { terminalUiTheme } from "../../theme/theme.js";
import {
  renderLatexMathToText,
  splitMarkdownMathSegments
} from "../../utils/math.js";
import { hasDisplayMathToken, renderMathToken, toInlineSpans } from "./inline.js";
import { asBoolean } from "./tokens.js";
import { createWrappedSpanBlock, normalizeInlineMarkdownText } from "./spans.js";
import type {
  MarkdownLineVariant,
  MarkdownRenderBlock,
  MarkdownSpan,
  MarkdownToken
} from "./types.js";

export function renderInlineContentWithMath(
  tokens: MarkdownToken[],
  width: number,
  key: string,
  indent: number,
  variant: Extract<MarkdownLineVariant, "paragraph" | "quote" | "list">,
  prefixFirst?: string,
  prefixRest?: string
): MarkdownRenderBlock[] {
  const hasDisplayMath = tokens.some(hasDisplayMathToken);
  if (!hasDisplayMath) {
    return [
      createWrappedSpanBlock(toInlineSpans(tokens), width, {
        key,
        indent,
        prefixFirst,
        prefixRest,
        variant
      })
    ];
  }

  return buildBlocksFromInlineTokens(tokens, width, key, indent, variant, prefixFirst, prefixRest);
}

export function buildBlocksFromMathSegments(
  segments: ReturnType<typeof splitMarkdownMathSegments>,
  width: number,
  key: string,
  indent: number,
  variant: Extract<MarkdownLineVariant, "paragraph" | "quote" | "list">,
  prefixFirst?: string,
  prefixRest?: string
): MarkdownRenderBlock[] {
  const blocks: MarkdownRenderBlock[] = [];
  let blockIndex = 0;
  let currentInlineSpans: MarkdownSpan[] = [];

  const flushInlineBlock = () => {
    if (currentInlineSpans.length === 0) {
      return;
    }

    blocks.push(createWrappedSpanBlock(currentInlineSpans, width, {
      key: `${key}-inline-${blockIndex}`,
      indent,
      prefixFirst: blocks.length === 0 ? prefixFirst : undefined,
      prefixRest,
      variant
    }));
    blockIndex += 1;
    currentInlineSpans = [];
  };

  for (const segment of segments) {
    if (segment.type === "text") {
      if (segment.content.length > 0) {
        currentInlineSpans.push({ text: normalizeInlineMarkdownText(segment.content) });
      }
      continue;
    }

    if (!segment.display) {
      currentInlineSpans.push({
        text: renderLatexMathToText(segment.content) || segment.content,
        color: terminalUiTheme.colors.markdownInlineCode,
        bold: true
      });
      continue;
    }

    flushInlineBlock();
    const continuedPrefix = blocks.length === 0 ? prefixFirst : prefixRest;
    const mathIndent = continuedPrefix ? indent : indent + 2;
    blocks.push(createWrappedSpanBlock([{
      text: renderLatexMathToText(segment.content) || segment.content,
      color: terminalUiTheme.colors.markdownInlineCode,
      bold: true
    }], width, {
      key: `${key}-math-${blockIndex}`,
      indent: mathIndent,
      prefixFirst: continuedPrefix,
      prefixRest,
      variant: "math"
    }));
    blockIndex += 1;
  }

  flushInlineBlock();

  if (blocks.length === 0) {
    blocks.push(createWrappedSpanBlock([{ text: " " }], width, {
      key: `${key}-empty`,
      indent,
      prefixFirst,
      prefixRest,
      variant
    }));
  }

  return blocks;
}

function buildBlocksFromInlineTokens(
  tokens: MarkdownToken[],
  width: number,
  key: string,
  indent: number,
  variant: Extract<MarkdownLineVariant, "paragraph" | "quote" | "list">,
  prefixFirst?: string,
  prefixRest?: string
): MarkdownRenderBlock[] {
  const blocks: MarkdownRenderBlock[] = [];
  let blockIndex = 0;
  let currentInlineSpans: MarkdownSpan[] = [];

  const flushInlineBlock = () => {
    if (currentInlineSpans.length === 0) {
      return;
    }

    blocks.push(createWrappedSpanBlock(currentInlineSpans, width, {
      key: `${key}-inline-${blockIndex}`,
      indent,
      prefixFirst: blocks.length === 0 ? prefixFirst : undefined,
      prefixRest,
      variant
    }));
    blockIndex += 1;
    currentInlineSpans = [];
  };

  for (const token of tokens) {
    if (token.type !== "math") {
      currentInlineSpans.push(...toInlineSpans([token]));
      continue;
    }

    if (!asBoolean(token.display)) {
      currentInlineSpans.push({
        text: renderMathToken(token),
        color: terminalUiTheme.colors.markdownInlineCode,
        bold: true
      });
      continue;
    }

    flushInlineBlock();
    const continuedPrefix = blocks.length === 0 ? prefixFirst : prefixRest;
    const mathIndent = continuedPrefix ? indent : indent + 2;
    blocks.push(createWrappedSpanBlock([{
      text: renderMathToken(token),
      color: terminalUiTheme.colors.markdownInlineCode,
      bold: true
    }], width, {
      key: `${key}-math-${blockIndex}`,
      indent: mathIndent,
      prefixFirst: continuedPrefix,
      prefixRest,
      variant: "math"
    }));
    blockIndex += 1;
  }

  flushInlineBlock();

  if (blocks.length === 0) {
    blocks.push(createWrappedSpanBlock([{ text: " " }], width, {
      key: `${key}-empty`,
      indent,
      prefixFirst,
      prefixRest,
      variant
    }));
  }

  return blocks;
}
