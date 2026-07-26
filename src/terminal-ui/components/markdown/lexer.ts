import { Marked, type TokenizerAndRendererExtension } from "marked";
import { readMarkdownMathSegmentAtStart } from "../../utils/math.js";

const CJK_SCRIPT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_EDGE_PUNCTUATION_PATTERN =
  /[\u2018\u2019\u201C\u201D\u3001-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u;
const markdownMathExtension: TokenizerAndRendererExtension = {
  name: "math",
  level: "inline",
  start(src: string): number | undefined {
    const index = src.indexOf("$");
    return index >= 0 ? index : undefined;
  },
  tokenizer(src: string) {
    const match = readMarkdownMathSegmentAtStart(src);
    if (!match) {
      return undefined;
    }

    return {
      type: "math",
      raw: match.raw,
      text: match.content,
      display: match.display
    };
  }
};
const markdownCjkStrongExtension: TokenizerAndRendererExtension = {
  name: "cjk-strong",
  level: "inline",
  start(src: string): number | undefined {
    const index = src.indexOf("**");
    return index >= 0 ? index : undefined;
  },
  tokenizer(src: string) {
    if (!src.startsWith("**") || src.startsWith("***")) {
      return undefined;
    }

    const closeIndex = src.indexOf("**", 2);
    if (closeIndex < 0) {
      return undefined;
    }

    const content = src.slice(2, closeIndex);
    if (
      content.length === 0 ||
      src[closeIndex + 2] === "*" ||
      !shouldForceCjkDelimitedFallback(content)
    ) {
      return undefined;
    }

    return {
      type: "strong",
      raw: src.slice(0, closeIndex + 2),
      text: content,
      tokens: this.lexer.inlineTokens(content)
    };
  }
};
const markdownCjkEmphasisExtension: TokenizerAndRendererExtension = {
  name: "cjk-emphasis",
  level: "inline",
  start(src: string): number | undefined {
    const index = src.indexOf("*");
    return index >= 0 ? index : undefined;
  },
  tokenizer(src: string) {
    if (!src.startsWith("*") || src.startsWith("**")) {
      return undefined;
    }

    const closeIndex = src.indexOf("*", 1);
    if (closeIndex < 0) {
      return undefined;
    }

    const content = src.slice(1, closeIndex);
    if (
      content.length === 0 ||
      src[closeIndex + 1] === "*" ||
      !shouldForceCjkDelimitedFallback(content)
    ) {
      return undefined;
    }

    return {
      type: "em",
      raw: src.slice(0, closeIndex + 1),
      text: content,
      tokens: this.lexer.inlineTokens(content)
    };
  }
};

export const markdownLexer = new Marked({
  gfm: true,
  breaks: true,
  extensions: [markdownMathExtension, markdownCjkStrongExtension, markdownCjkEmphasisExtension]
});

function shouldForceCjkDelimitedFallback(content: string): boolean {
  if (content.trim() !== content || !CJK_SCRIPT_PATTERN.test(content)) {
    return false;
  }

  const characters = Array.from(content);
  if (characters.length === 0) {
    return false;
  }

  const first = characters[0] ?? "";
  const last = characters[characters.length - 1] ?? "";
  return (
    CJK_EDGE_PUNCTUATION_PATTERN.test(first) ||
    CJK_EDGE_PUNCTUATION_PATTERN.test(last)
  );
}
