export function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) {
    return value;
  }

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const raw = entity.slice(1);
      const codePoint =
        raw[0]?.toLowerCase() === "x" ? Number.parseInt(raw.slice(1), 16) : Number.parseInt(raw, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
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
