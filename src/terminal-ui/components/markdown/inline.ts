import { asString } from "../../../core/util/unknown.js";
import { terminalUiTheme } from "../../theme/theme.js";
import {
  renderLatexMathToText,
  splitMarkdownMathSegments
} from "../../utils/math.js";
import {
  asBoolean,
  getInlineTokenSource,
  getNestedTokens
} from "./tokens.js";
import {
  applySpanStyle,
  mergeAdjacentSpans,
  normalizeInlineMarkdownText
} from "./spans.js";
import type { MarkdownSpan, MarkdownToken } from "./types.js";

export function toInlineSpans(tokens: MarkdownToken[]): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const nestedTokens = getNestedTokens(token);
        if (nestedTokens.length > 0) {
          spans.push(...toInlineSpans(nestedTokens));
        } else {
          spans.push(...spansFromMarkdownText(asString(token.text) ?? asString(token.raw) ?? ""));
        }
        break;
      }
      case "strong":
        spans.push(...applySpanStyle(toInlineSpans(getNestedTokens(token)), { bold: true }));
        break;
      case "em":
        spans.push(...applySpanStyle(toInlineSpans(getNestedTokens(token)), { italic: true }));
        break;
      case "codespan":
        spans.push({
          text: normalizeInlineMarkdownText(asString(token.text) ?? asString(token.raw) ?? ""),
          color: terminalUiTheme.colors.markdownInlineCode
        });
        break;
      case "del":
        spans.push(...applySpanStyle(toInlineSpans(getNestedTokens(token)), { strikethrough: true }));
        break;
      case "math":
        spans.push({
          text: renderMathToken(token),
          color: terminalUiTheme.colors.markdownInlineCode,
          bold: true
        });
        break;
      case "br":
        spans.push({ text: "\n" });
        break;
      case "link": {
        const nestedTokens = getNestedTokens(token);
        const linkSpans =
          nestedTokens.length > 0
            ? toInlineSpans(nestedTokens)
            : spansFromMarkdownText(
                asString(token.text) ?? asString(token.href) ?? asString(token.raw) ?? ""
              );
        spans.push(...buildLinkDisplaySpans(linkSpans, asString(token.href)));
        break;
      }
      case "image":
        spans.push({
          text: `[image: ${normalizeInlineMarkdownText(asString(token.text) ?? asString(token.href) ?? "asset")}]`,
          color: terminalUiTheme.colors.markdownLink,
          href: asString(token.href)
        });
        break;
      case "html":
        spans.push({
          text: normalizeInlineMarkdownText(asString(token.raw) ?? asString(token.text) ?? ""),
          dim: true
        });
        break;
      default:
        spans.push(...spansFromMarkdownText(asString(token.text) ?? asString(token.raw) ?? ""));
        break;
    }
  }

  return mergeAdjacentSpans(spans);
}

function spansFromMarkdownText(text: string): MarkdownSpan[] {
  const segments = splitMarkdownMathSegments(text);
  const spans: MarkdownSpan[] = [];

  for (const segment of segments) {
    if (segment.type === "text") {
      if (segment.content.length > 0) {
        spans.push({
          text: normalizeInlineMarkdownText(segment.content)
        });
      }
      continue;
    }

    if (segment.display) {
      spans.push({
        text: `\n${renderLatexMathToText(segment.content) || segment.content}\n`,
        color: terminalUiTheme.colors.markdownInlineCode,
        bold: true
      });
      continue;
    }

    spans.push({
      text: renderLatexMathToText(segment.content) || segment.content,
      color: terminalUiTheme.colors.markdownInlineCode,
      bold: true
    });
  }

  return spans.length > 0 ? spans : [{ text: "" }];
}

export function hasDisplayMathToken(token: MarkdownToken): boolean {
  if (token.type === "math") {
    return asBoolean(token.display);
  }

  return getNestedTokens(token).some(hasDisplayMathToken);
}

export function renderMathToken(token: MarkdownToken): string {
  const content = asString(token.text) ?? asString(token.raw) ?? "";
  return renderLatexMathToText(content) || content;
}

function buildLinkDisplaySpans(
  labelSpans: MarkdownSpan[],
  href: string | undefined
): MarkdownSpan[] {
  if (!href) {
    return labelSpans;
  }

  const styledLabelSpans = applySpanStyle(labelSpans, {
    color: terminalUiTheme.colors.markdownLink,
    underline: true,
    href
  });
  const renderedLabel = labelSpans.map((span) => span.text).join("");
  if (!shouldAppendLinkHrefPreview(renderedLabel, href)) {
    return styledLabelSpans;
  }

  return [
    ...styledLabelSpans,
    {
      text: ` <${href}>`,
      color: terminalUiTheme.colors.markdownLinkUrl,
      href
    }
  ];
}

function shouldAppendLinkHrefPreview(label: string, href: string): boolean {
  const normalizedLabel = normalizeComparableLinkText(label);
  const normalizedHref = normalizeComparableLinkText(href);
  if (!normalizedLabel || !normalizedHref) {
    return false;
  }

  return normalizedLabel !== normalizedHref;
}

function normalizeComparableLinkText(value: string): string {
  return value
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "")
    .replace(/[\/\s]+$/g, "")
    .toLowerCase();
}
