const MAX_MARKDOWN_PARSE_INPUT_CHARS = 180_000;
const MAX_MARKDOWN_PARSE_LINES = 6_000;
const MAX_MARKDOWN_PARSE_NESTING_DEPTH = 32;

export function assertWithinParseBudget(content: string) {
  if (content.length > MAX_MARKDOWN_PARSE_INPUT_CHARS) {
    throw new Error(
      `Markdown content budget exceeded: ${content.length}/${MAX_MARKDOWN_PARSE_INPUT_CHARS}`
    );
  }

  const lines = content.split("\n");
  if (lines.length > MAX_MARKDOWN_PARSE_LINES) {
    throw new Error(
      `Markdown line budget exceeded: ${lines.length}/${MAX_MARKDOWN_PARSE_LINES}`
    );
  }

  const maxNestingDepth = resolveMaxMarkdownNestingDepth(lines);
  if (maxNestingDepth > MAX_MARKDOWN_PARSE_NESTING_DEPTH) {
    throw new Error(
      `Markdown nesting budget exceeded: ${maxNestingDepth}/${MAX_MARKDOWN_PARSE_NESTING_DEPTH}`
    );
  }
}

function resolveMaxMarkdownNestingDepth(lines: string[]) {
  let maxDepth = 0;
  let activeFence: {
    marker: "`" | "~";
    length: number;
  } | null = null;

  for (const line of lines) {
    const fence = resolveFenceMarker(line);
    if (activeFence) {
      if (
        fence &&
        fence.marker === activeFence.marker &&
        fence.length >= activeFence.length &&
        fence.trailing.trim().length === 0
      ) {
        activeFence = null;
      }
      continue;
    }

    if (fence) {
      activeFence = {
        marker: fence.marker,
        length: fence.length
      };
      continue;
    }

    maxDepth = Math.max(
      maxDepth,
      resolveQuoteDepth(line),
      resolveListDepth(line)
    );
  }

  return maxDepth;
}

function resolveFenceMarker(line: string): {
  marker: "`" | "~";
  length: number;
  trailing: string;
} | null {
  const match = line.match(/^([ \t]*)([`~]{3,})(.*)$/);
  if (!match) {
    return null;
  }

  const indentation = match[1]?.replace(/\t/g, "  ").length ?? 0;
  if (indentation > 3) {
    return null;
  }

  const markers = match[2] ?? "";
  const marker = markers[0];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  return {
    marker,
    length: markers.length,
    trailing: match[3] ?? ""
  };
}

function resolveQuoteDepth(line: string) {
  let index = 0;
  while (index < line.length && (line[index] === " " || line[index] === "\t")) {
    index += 1;
  }

  let depth = 0;
  while (index < line.length && line[index] === ">") {
    depth += 1;
    index += 1;
    while (index < line.length && line[index] === " ") {
      index += 1;
    }
  }

  return depth;
}

function resolveListDepth(line: string) {
  const match = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+/);
  if (!match) {
    return 0;
  }

  const indentation = match[1]?.replace(/\t/g, "  ").length ?? 0;
  return Math.floor(indentation / 2) + 1;
}
