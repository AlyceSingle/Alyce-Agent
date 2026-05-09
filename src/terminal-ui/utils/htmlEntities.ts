export const MAX_HTML_ENTITY_DECODE_PASSES = 8;

export interface NormalizeMarkdownInputOptions {
  decodeEntities?: boolean;
  normalizeLineEndings?: boolean;
}

export function decodeHtmlEntities(value: string, maxPasses = MAX_HTML_ENTITY_DECODE_PASSES): string {
  if (!value.includes("&")) {
    return value;
  }

  const safeMaxPasses = Number.isFinite(maxPasses) ? Math.max(0, Math.trunc(maxPasses)) : MAX_HTML_ENTITY_DECODE_PASSES;

  // 有些模型会输出双重转义实体（例如 &amp;quot;），这里做有限次解码。
  // 对非法/未知实体保持原样，避免误改文本。
  let decoded = value;
  for (let pass = 0; pass < safeMaxPasses; pass += 1) {
    const next = decodeHtmlEntitiesOnce(decoded);
    if (next === decoded) {
      break;
    }

    decoded = next;
    if (!decoded.includes("&")) {
      break;
    }
  }

  return decoded;
}

export function normalizeMarkdownInput(value: string, options: NormalizeMarkdownInputOptions = {}): string {
  const normalizeLineEndings = options.normalizeLineEndings !== false;
  const decodeEntities = options.decodeEntities !== false;

  const normalized = normalizeLineEndings ? value.replace(/\r\n?/g, "\n") : value;
  return decodeEntities ? decodeHtmlEntities(normalized) : normalized;
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const raw = entity.slice(1);
      const codePoint =
        raw[0]?.toLowerCase() === "x" ? Number.parseInt(raw.slice(1), 16) : Number.parseInt(raw, 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }

    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return match;
    }
  });
}
