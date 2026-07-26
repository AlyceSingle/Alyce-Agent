import { asString } from "../../../core/util/unknown.js";
import {
  createWrappedSpanBlock,
  normalizeInlineMarkdownText,
  wrapSpans
} from "./spans.js";
import type {
  MarkdownRenderBlock,
  MarkdownRenderLine,
  MarkdownToken
} from "./types.js";

export function renderCodeBlock(
  token: MarkdownToken,
  width: number,
  key: string,
  baseIndent: number
): MarkdownRenderBlock {
  const language = asString(token.lang)?.trim();
  const lines: MarkdownRenderLine[] = [];

  if (language) {
    lines.push({
      key: `${key}-label`,
      indent: baseIndent + 2,
      prefix: "",
      spans: [{ text: `[${language}]` }],
      variant: "code-label"
    });
  }

  const codeLines = String(token.text ?? token.raw ?? "").split(/\r?\n/);
  for (let index = 0; index < codeLines.length; index += 1) {
    const line = codeLines[index] ?? "";
    lines.push(
      ...wrapSpans([{ text: line || " " }], width, {
        key: `${key}-code-${index}`,
        indent: baseIndent + 2,
        variant: "code"
      })
    );
  }

  return {
    key,
    marginTop: 0,
    lines
  };
}

export function renderRawBlock(
  content: string,
  width: number,
  key: string,
  baseIndent: number
): MarkdownRenderBlock {
  return createWrappedSpanBlock([{ text: normalizeInlineMarkdownText(content) }], width, {
    key,
    indent: baseIndent,
    variant: "paragraph"
  });
}
