import { Marked, type Tokens } from "marked";

type FenceState = {
  char: "`" | "~";
  size: number;
};

export interface MarkdownStreamBlock {
  src: string;
  mode: "full" | "live";
}

export interface StabilizeMarkdownOptions {
  live?: boolean;
}

const streamLexer = new Marked({
  gfm: true,
  breaks: true
});

const FENCE_LINE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/;
const REFERENCE_PATTERN = /^\[[^\]]+\]:\s+\S+/m;
const FOOTNOTE_PATTERN = /^\[\^[^\]]+\]:\s+/m;

export function streamMarkdownForRender(markdown: string, live: boolean): MarkdownStreamBlock[] {
  if (!live) {
    return [{
      src: stabilizeMarkdownForRender(markdown, { live: false }),
      mode: "full"
    }];
  }

  const stabilized = stabilizeMarkdownForRender(markdown, { live: true });
  if (hasReferenceDefinitions(markdown)) {
    return [{ src: stabilized, mode: "live" }];
  }

  const tokens = streamLexer.lexer(markdown);
  const tail = findLastTokenIndex(tokens);
  if (tail < 0) {
    return [{ src: stabilized, mode: "live" }];
  }

  const last = tokens[tail];
  if (!last || last.type !== "code") {
    return [{ src: stabilized, mode: "live" }];
  }

  const codeToken = last as Tokens.Code;
  if (!isOpenFence(codeToken.raw ?? "")) {
    return [{ src: stabilized, mode: "live" }];
  }

  const head = tokens
    .slice(0, tail)
    .map((token) => asRawToken(token))
    .join("");

  if (!head) {
    return [{
      src: stabilizeMarkdownForRender(codeToken.raw ?? "", { live: true }),
      mode: "live"
    }];
  }

  return [
    {
      src: stabilizeMarkdownForRender(head, { live: true }),
      mode: "live"
    },
    {
      src: stabilizeMarkdownForRender(codeToken.raw ?? "", { live: true }),
      mode: "live"
    }
  ];
}

export function stabilizeMarkdownForRender(markdown: string, options: StabilizeMarkdownOptions = {}): string {
  const live = options.live === true;
  let stabilized = markdown;

  if (live) {
    stabilized = repairDanglingMarkdownSyntax(stabilized);
  }

  stabilized = closeOpenFences(stabilized);
  return stabilized;
}

function hasReferenceDefinitions(text: string) {
  return REFERENCE_PATTERN.test(text) || FOOTNOTE_PATTERN.test(text);
}

function findLastTokenIndex(tokens: ReturnType<Marked["lexer"]>) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type !== "space") {
      return index;
    }
  }
  return -1;
}

function asRawToken(token: ReturnType<Marked["lexer"]>[number]) {
  return typeof token.raw === "string" ? token.raw : "";
}

function repairDanglingMarkdownSyntax(markdown: string) {
  let repaired = markdown;

  if (/\[[^\]\n]*\]\([^\)\n]*$/.test(repaired)) {
    repaired += ")";
  }

  if (/\[[^\]\n]*$/.test(repaired)) {
    repaired += "]";
  }

  if (hasOddUnescapedBackticks(getLastLine(repaired))) {
    repaired += "`";
  }

  const lastNonEmpty = getLastNonEmptyLine(repaired);
  if (lastNonEmpty && /^[ \t]{0,3}>\s*$/.test(lastNonEmpty)) {
    repaired += " ";
  }

  if (lastNonEmpty && /^[ \t]{0,3}(?:[-+*]|\d+\.)\s*$/.test(lastNonEmpty)) {
    repaired += " ";
  }

  return repaired;
}

function getLastLine(markdown: string) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  return lines[lines.length - 1] ?? "";
}

function getLastNonEmptyLine(markdown: string) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && line.trim().length > 0) {
      return line;
    }
  }
  return "";
}

function hasOddUnescapedBackticks(line: string) {
  let count = 0;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "`") {
      count += 1;
    }
  }

  return count % 2 === 1;
}

function closeOpenFences(markdown: string) {
  if (!markdown.includes("```") && !markdown.includes("~~~")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  let activeFence: FenceState | null = null;

  for (const line of lines) {
    if (activeFence) {
      if (isFenceClosingLine(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const match = line.match(FENCE_LINE_PATTERN);
    if (!match) {
      continue;
    }

    const marker = match[1] ?? "";
    const char = marker[0] === "~" ? "~" : "`";
    const size = marker.length;
    activeFence = { char, size };
  }

  if (!activeFence) {
    return markdown;
  }

  const suffix = activeFence.char.repeat(activeFence.size);

  if (!suffix) {
    return markdown;
  }

  const needsLeadingLineBreak = !markdown.endsWith("\n");
  return `${markdown}${needsLeadingLineBreak ? "\n" : ""}${suffix}`;
}

function isOpenFence(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) {
    return false;
  }
  const marker = match[1];
  if (!marker) {
    return false;
  }
  const char = marker[0];
  const size = marker.length;
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? "";
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
}

function isFenceClosingLine(line: string, fence: FenceState): boolean {
  const match = line.match(/^([ \t]{0,3})([`~]{3,})[ \t]*$/);
  if (!match) {
    return false;
  }

  const marker = match[2] ?? "";
  return marker.length >= fence.size && marker.split("").every((character) => character === fence.char);
}
