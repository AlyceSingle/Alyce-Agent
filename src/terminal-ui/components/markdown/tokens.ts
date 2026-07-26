import { asString } from "../../../core/util/unknown.js";
import type { MarkdownToken } from "./types.js";

export function isInlineBlockToken(token: MarkdownToken): boolean {
  return token.type === "paragraph" || token.type === "text" || token.type === "heading";
}

export function getNestedTokens(token: MarkdownToken): MarkdownToken[] {
  return asTokenArray(token.tokens);
}

export function getInlineTokenSource(token: MarkdownToken): MarkdownToken[] {
  const nestedTokens = getNestedTokens(token);
  return nestedTokens.length > 0 ? nestedTokens : fallbackTextTokenArray(token);
}

export function fallbackTextTokenArray(token: MarkdownToken): MarkdownToken[] {
  const text = asString(token.text) ?? asString(token.raw) ?? "";
  return text
    ? [
        {
          type: "text",
          text
        }
      ]
    : [];
}

export function getListItemPrefix(item: MarkdownToken): string {
  if (asBoolean(item.task)) {
    return `[${asBoolean(item.checked) ? "x" : " "}] `;
  }

  return "• ";
}

export function clampHeadingDepth(depth: number | undefined): number {
  if (!depth || depth < 1) {
    return 1;
  }

  return Math.min(6, Math.trunc(depth));
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asTokenArray(value: unknown): MarkdownToken[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is MarkdownToken => {
    return Boolean(item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string");
  });
}
