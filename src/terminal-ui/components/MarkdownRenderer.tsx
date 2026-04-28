import React from "react";
import { marked } from "marked";
import { Box, Text } from "../runtime/ink.js";
import type { TerminalUiMessageKind } from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { decodeHtmlEntities } from "../utils/htmlEntities.js";
import { measureCharWidth } from "../utils/text.js";

type MarkdownToken = {
  type: string;
} & Record<string, unknown>;

type MarkdownSpanStyle = {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
  href?: string;
};

type MarkdownSpan = MarkdownSpanStyle & {
  text: string;
  href?: string;
};

type MarkdownCharacter = MarkdownSpanStyle & {
  char: string;
  href?: string;
};

type MarkdownLineVariant =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "quote"
  | "list"
  | "code"
  | "code-label"
  | "rule"
  | "table";

export interface MarkdownRenderLine {
  key: string;
  indent: number;
  prefix: string;
  spans: MarkdownSpan[];
  variant: MarkdownLineVariant;
}

export interface MarkdownRenderBlock {
  key: string;
  marginTop: number;
  lines: MarkdownRenderLine[];
}

export interface MarkdownRenderPlan {
  blocks: MarkdownRenderBlock[];
  rowCount: number;
}

const MAX_MARKDOWN_PLAN_CACHE_ENTRIES = 128;
const markdownPlanCache = new Map<string, MarkdownRenderPlan>();

export function buildMarkdownRenderPlan(content: string, width: number): MarkdownRenderPlan {
  const safeWidth = Math.max(16, width);
  const normalizedContent = content.trim().length > 0 ? content : "(empty)";
  const cacheKey = `${safeWidth}:${normalizedContent}`;
  const cachedPlan = markdownPlanCache.get(cacheKey);
  if (cachedPlan) {
    markdownPlanCache.delete(cacheKey);
    markdownPlanCache.set(cacheKey, cachedPlan);
    return cachedPlan;
  }

  const tokens = marked.lexer(normalizedContent, {
    gfm: true,
    breaks: true
  }) as MarkdownToken[];
  const blocks = renderBlockTokens(tokens, safeWidth, "md", 0);
  const plan = {
    blocks,
    rowCount: blocks.reduce((sum, block) => sum + block.marginTop + block.lines.length, 0)
  };

  markdownPlanCache.set(cacheKey, plan);
  if (markdownPlanCache.size > MAX_MARKDOWN_PLAN_CACHE_ENTRIES) {
    const firstKey = markdownPlanCache.keys().next().value;
    if (firstKey) {
      markdownPlanCache.delete(firstKey);
    }
  }

  return plan;
}

export function shouldRenderMarkdownMessage(
  kind: TerminalUiMessageKind,
  enabled: boolean
): boolean {
  return enabled && (kind === "assistant" || kind === "thinking");
}

export function sliceMarkdownRenderPlan(
  plan: MarkdownRenderPlan,
  startRow: number,
  endRow: number
): MarkdownRenderBlock[] {
  const clampedStart = Math.max(0, startRow);
  const clampedEnd = Math.max(clampedStart, Math.min(plan.rowCount, endRow));
  const blocks: MarkdownRenderBlock[] = [];
  let blockStartRow = 0;

  for (const block of plan.blocks) {
    const marginStartRow = blockStartRow;
    const lineStartRow = marginStartRow + block.marginTop;
    const blockEndRow = lineStartRow + block.lines.length;
    blockStartRow = blockEndRow;

    if (blockEndRow <= clampedStart || marginStartRow >= clampedEnd) {
      continue;
    }

    const visibleMarginStart = Math.max(marginStartRow, clampedStart);
    const visibleMarginEnd = Math.min(lineStartRow, clampedEnd);
    const visibleMarginTop = Math.max(0, visibleMarginEnd - visibleMarginStart);
    const visibleLineStart = Math.max(0, clampedStart - lineStartRow);
    const visibleLineEnd = Math.min(block.lines.length, clampedEnd - lineStartRow);
    const visibleLines = block.lines.slice(visibleLineStart, visibleLineEnd);

    if (visibleMarginTop === 0 && visibleLines.length === 0) {
      continue;
    }

    blocks.push({
      ...block,
      marginTop: visibleMarginTop,
      lines: visibleLines
    });
  }

  return blocks;
}

export function MarkdownRenderer(props: {
  plan: MarkdownRenderPlan;
  kind: TerminalUiMessageKind;
  baseColor?: string;
}) {
  return (
    <Box flexDirection="column" width="100%">
      {props.plan.blocks.map((block) => (
        <Box key={block.key} flexDirection="column" marginTop={block.marginTop} width="100%">
          {block.lines.map((line) => {
            const lineStyle = getLineStyle(line.variant, props.kind, props.baseColor);

            return (
              <Text
                key={line.key}
                {...buildInkTextProps(lineStyle)}
              >
                {renderLineContent(line)}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function renderLineContent(line: MarkdownRenderLine) {
  const prefixText = `${" ".repeat(Math.max(0, line.indent))}${line.prefix}`;

  if (line.spans.length === 0) {
    return prefixText || " ";
  }

  return (
    <>
      {prefixText}
      {line.spans.map((span, index) => (
        <React.Fragment key={`${line.key}-span-${index}`}>
          {renderSpan(span)}
        </React.Fragment>
      ))}
    </>
  );
}

function getLineStyle(
  variant: MarkdownLineVariant,
  kind: TerminalUiMessageKind,
  baseColor: string | undefined
): MarkdownSpanStyle {
  const defaultColor =
    baseColor ??
    (kind === "thinking"
      ? terminalUiTheme.colors.messageCardMuted
      : terminalUiTheme.colors.messageCardText);

  switch (variant) {
    case "heading-1":
      return {
        color: terminalUiTheme.colors.markdownHeading1,
        bold: true
      };
    case "heading-2":
      return {
        color: terminalUiTheme.colors.markdownHeading2,
        bold: true
      };
    case "heading-3":
      return {
        color: terminalUiTheme.colors.markdownHeading3,
        bold: true
      };
    case "heading-4":
      return {
        color: terminalUiTheme.colors.markdownHeading4,
        bold: true
      };
    case "quote":
      return {
        color: terminalUiTheme.colors.markdownQuote
      };
    case "code":
      return {
        color: terminalUiTheme.colors.code
      };
    case "code-label":
      return {
        color: terminalUiTheme.colors.markdownCodeLabel,
        bold: true
      };
    case "rule":
      return {
        color: terminalUiTheme.colors.markdownRule
      };
    case "table":
      return {
        color: terminalUiTheme.colors.markdownTable
      };
    case "list":
    case "paragraph":
    default:
      return {
        color: defaultColor
      };
  }
}

function renderBlockTokens(
  tokens: MarkdownToken[],
  width: number,
  keyPrefix: string,
  baseIndent: number
): MarkdownRenderBlock[] {
  const blocks: MarkdownRenderBlock[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    const rendered = renderSingleBlockToken(token, width, `${keyPrefix}-${index}`, baseIndent);
    if (rendered.length === 0) {
      continue;
    }

    if (blocks.length > 0) {
      rendered[0] = {
        ...rendered[0],
        marginTop: Math.max(1, rendered[0].marginTop)
      };
    }

    blocks.push(...rendered);
  }

  return blocks;
}

function renderSingleBlockToken(
  token: MarkdownToken,
  width: number,
  key: string,
  baseIndent: number
): MarkdownRenderBlock[] {
  switch (token.type) {
    case "space":
      return [];
    case "hr":
      return [
        {
          key,
          marginTop: 0,
          lines: [
            {
              key: `${key}-line`,
              indent: baseIndent,
              prefix: "",
              spans: [{ text: "─".repeat(Math.max(4, width - baseIndent)) }],
              variant: "rule"
            }
          ]
        }
      ];
    case "heading": {
      const depth = clampHeadingDepth(asNumber(token.depth));
      return [
        createWrappedSpanBlock(toInlineSpans(getInlineTokenSource(token)), width, {
          key,
          indent: baseIndent,
          prefixFirst: `${"#".repeat(depth)} `,
          variant: `heading-${Math.min(depth, 4)}` as MarkdownLineVariant
        })
      ];
    }
    case "paragraph":
    case "text":
      return [
        createWrappedSpanBlock(toInlineSpans(getInlineTokenSource(token)), width, {
          key,
          indent: baseIndent,
          variant: "paragraph"
        })
      ];
    case "blockquote": {
      const nestedTokens = getNestedTokens(token);
      const rendered = renderBlockTokens(
        nestedTokens.length > 0 ? nestedTokens : fallbackTextTokenArray(token),
        width,
        `${key}-quote`,
        baseIndent
      );
      return prefixRenderedBlocks(rendered, "│ ", `${key}-quote`);
    }
    case "list":
      return renderListToken(token, width, key, baseIndent);
    case "code":
      return [renderCodeBlock(token, width, key, baseIndent)];
    case "table":
      return [renderTableBlock(token, width, key, baseIndent)];
    case "html":
      return [renderRawBlock(asString(token.raw) ?? asString(token.text) ?? "", width, key, baseIndent)];
    default: {
      const fallbackText = asString(token.text) ?? asString(token.raw) ?? "";
      if (!fallbackText.trim()) {
        return [];
      }

      return [renderRawBlock(fallbackText, width, key, baseIndent)];
    }
  }
}

function renderListToken(
  token: MarkdownToken,
  width: number,
  key: string,
  baseIndent: number
): MarkdownRenderBlock[] {
  const items = asTokenArray(token.items);
  const ordered = asBoolean(token.ordered);
  const start = asNumber(token.start) ?? 1;
  const blocks: MarkdownRenderBlock[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) {
      continue;
    }

    const prefix = ordered ? `${start + index}. ` : getListItemPrefix(item);
    const continuationPrefix = " ".repeat(measureStringWidth(prefix));
    const nestedTokens = getNestedTokens(item);
    const firstToken = nestedTokens[0];
    const itemKey = `${key}-item-${index}`;

    if (firstToken && isInlineBlockToken(firstToken)) {
      blocks.push(
        createWrappedSpanBlock(toInlineSpans(getInlineTokenSource(firstToken)), width, {
          key: `${itemKey}-head`,
          indent: baseIndent,
          prefixFirst: prefix,
          prefixRest: continuationPrefix,
          variant: "list"
        })
      );

      const tailBlocks = renderBlockTokens(
        nestedTokens.slice(1),
        width,
        `${itemKey}-tail`,
        baseIndent + measureStringWidth(prefix)
      );
      blocks.push(...tailBlocks);
      continue;
    }

    if (nestedTokens.length === 0) {
      const fallbackText = asString(item.text) ?? "";
      blocks.push(
        createWrappedSpanBlock([{ text: fallbackText || " " }], width, {
          key: `${itemKey}-fallback`,
          indent: baseIndent,
          prefixFirst: prefix,
          prefixRest: continuationPrefix,
          variant: "list"
        })
      );
      continue;
    }

    blocks.push({
      key: `${itemKey}-marker`,
      marginTop: 0,
      lines: [
        {
          key: `${itemKey}-marker-line`,
          indent: baseIndent,
          prefix,
          spans: [{ text: " " }],
          variant: "list"
        }
      ]
    });
    blocks.push(
      ...renderBlockTokens(
        nestedTokens,
        width,
        `${itemKey}-body`,
        baseIndent + measureStringWidth(prefix)
      )
    );
  }

  return blocks;
}

function renderCodeBlock(
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

function renderTableBlock(
  token: MarkdownToken,
  width: number,
  key: string,
  baseIndent: number
): MarkdownRenderBlock {
  const headerCells = asTableCells(token.header);
  const rowCells = asTableRows(token.rows);
  const columnCount = headerCells.length;
  if (columnCount === 0) {
    return renderRawBlock(String(token.raw ?? token.text ?? ""), width, key, baseIndent);
  }

  const availableWidth = Math.max(12, width - baseIndent);
  const separatorWidth = Math.max(0, (columnCount - 1) * 3);
  const maxContentWidth = Math.max(4, availableWidth - separatorWidth);
  const columnWidths = resolveTableColumnWidths(
    [headerCells, ...rowCells],
    maxContentWidth
  );
  const lines: MarkdownRenderLine[] = [];

  lines.push(...buildTableRowLines(headerCells, columnWidths, `${key}-head`, "table", true));
  lines.push(buildTableDividerLine(columnWidths, `${key}-divider`, baseIndent));

  for (let index = 0; index < rowCells.length; index += 1) {
    lines.push(
      ...buildTableRowLines(
        rowCells[index] ?? [],
        columnWidths,
        `${key}-row-${index}`,
        "table",
        false
      )
    );
  }

  for (const line of lines) {
    line.indent += baseIndent;
  }

  return {
    key,
    marginTop: 0,
    lines
  };
}

function renderRawBlock(
  content: string,
  width: number,
  key: string,
  baseIndent: number
): MarkdownRenderBlock {
  return createWrappedSpanBlock([{ text: decodeHtmlEntities(content) }], width, {
    key,
    indent: baseIndent,
    variant: "paragraph"
  });
}

function createWrappedSpanBlock(
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

function prefixRenderedBlocks(
  blocks: MarkdownRenderBlock[],
  prefix: string,
  keyPrefix: string
): MarkdownRenderBlock[] {
  return blocks.map((block, blockIndex) => ({
    ...block,
    key: `${keyPrefix}-${blockIndex}`,
    lines: block.lines.map((line, lineIndex) => ({
      ...line,
      key: `${line.key}-prefixed-${lineIndex}`,
      prefix: `${prefix}${line.prefix}`,
      variant:
        line.variant === "code" || line.variant === "code-label" ? line.variant : "quote"
    }))
  }));
}

function wrapSpans(
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

function toInlineSpans(tokens: MarkdownToken[]): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const nestedTokens = getNestedTokens(token);
        if (nestedTokens.length > 0) {
          spans.push(...toInlineSpans(nestedTokens));
        } else {
          spans.push({ text: decodeHtmlEntities(asString(token.text) ?? asString(token.raw) ?? "") });
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
          text: decodeCodeLiteral(asString(token.text) ?? asString(token.raw) ?? ""),
          color: terminalUiTheme.colors.markdownInlineCode
        });
        break;
      case "del":
        spans.push(...applySpanStyle(toInlineSpans(getNestedTokens(token)), { strikethrough: true }));
        break;
      case "br":
        spans.push({ text: "\n" });
        break;
      case "link": {
        const nestedTokens = getNestedTokens(token);
        const linkSpans =
          nestedTokens.length > 0
            ? toInlineSpans(nestedTokens)
            : [{
                text: decodeHtmlEntities(
                  asString(token.text) ?? asString(token.href) ?? asString(token.raw) ?? ""
                )
              }];
        spans.push(
          ...applySpanStyle(linkSpans, {
            color: terminalUiTheme.colors.markdownLink,
            underline: true,
            href: asString(token.href)
          })
        );
        break;
      }
      case "image":
        spans.push({
          text: `[image: ${decodeHtmlEntities(asString(token.text) ?? asString(token.href) ?? "asset")}]`,
          color: terminalUiTheme.colors.markdownLink,
          href: asString(token.href)
        });
        break;
      case "html":
        spans.push({
          text: decodeHtmlEntities(asString(token.raw) ?? asString(token.text) ?? ""),
          dim: true
        });
        break;
      default:
        spans.push({ text: decodeHtmlEntities(asString(token.text) ?? asString(token.raw) ?? "") });
        break;
    }
  }

  return mergeAdjacentSpans(spans);
}

function applySpanStyle(spans: MarkdownSpan[], style: MarkdownSpanStyle): MarkdownSpan[] {
  return spans.map((span) => ({
    ...span,
    ...style
  }));
}

function mergeAdjacentSpans(spans: MarkdownSpan[]): MarkdownSpan[] {
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

function buildInkTextProps(style: MarkdownSpanStyle): React.ComponentProps<typeof Text> {
  const props: Record<string, unknown> = {};

  if (style.color) {
    props.color = style.color;
  }

  if (style.bold) {
    props.bold = true;
  } else if (style.dim) {
    props.dim = true;
  }

  if (style.italic) {
    props.italic = true;
  }

  if (style.underline) {
    props.underline = true;
  }

  if (style.strikethrough) {
    props.strikethrough = true;
  }

  return props as React.ComponentProps<typeof Text>;
}

function renderSpan(span: MarkdownSpan) {
  const node = <Text {...buildInkTextProps(span)}>{span.text}</Text>;
  if (!span.href) {
    return node;
  }

  return React.createElement("ink-link", { href: span.href }, node);
}

type MarkdownTableCell = {
  text: string;
  align?: "left" | "center" | "right" | null;
  spans: MarkdownSpan[];
  header: boolean;
};

function buildTableRowLines(
  cells: MarkdownTableCell[],
  columnWidths: number[],
  key: string,
  variant: MarkdownLineVariant,
  header: boolean
): MarkdownRenderLine[] {
  const cellLines = columnWidths.map((columnWidth, index) => {
    const cell = cells[index];
    if (!cell) {
      return wrapSpans([{ text: " " }], columnWidth, {
        key: `${key}-empty-${index}`,
        indent: 0,
        variant
      });
    }

    const spans = header ? applySpanStyle(cell.spans, { bold: true }) : cell.spans;
    return wrapSpans(spans.length > 0 ? spans : [{ text: " " }], columnWidth, {
      key: `${key}-cell-${index}`,
      indent: 0,
      variant
    });
  });
  const rowHeight = cellLines.reduce((max, lines) => Math.max(max, lines.length), 1);
  const lines: MarkdownRenderLine[] = [];

  for (let rowIndex = 0; rowIndex < rowHeight; rowIndex += 1) {
    const spans: MarkdownSpan[] = [];
    for (let columnIndex = 0; columnIndex < columnWidths.length; columnIndex += 1) {
      if (columnIndex > 0) {
        spans.push({
          text: " │ ",
          color: terminalUiTheme.colors.markdownTableDivider
        });
      }

      const line = cellLines[columnIndex]?.[rowIndex];
      const alignment = cells[columnIndex]?.align ?? null;
      const contentSpans = line?.spans ?? [{ text: " " }];
      spans.push(...alignTableCellSpans(contentSpans, columnWidths[columnIndex] ?? 4, alignment));
    }

    lines.push({
      key: `${key}-${rowIndex}`,
      indent: 0,
      prefix: "",
      spans,
      variant
    });
  }

  return lines;
}

function buildTableDividerLine(
  columnWidths: number[],
  key: string,
  indent: number
): MarkdownRenderLine {
  const divider = columnWidths.map((columnWidth) => "─".repeat(Math.max(1, columnWidth))).join("─┼─");
  return {
    key,
    indent,
    prefix: "",
    spans: [{ text: divider }],
    variant: "rule"
  };
}

function alignTableCellSpans(
  spans: MarkdownSpan[],
  width: number,
  align: "left" | "center" | "right" | null | undefined
): MarkdownSpan[] {
  const currentWidth = measureSpansWidth(spans);
  const padding = Math.max(0, width - currentWidth);
  if (padding === 0) {
    return spans;
  }

  switch (align) {
    case "right":
      return [{ text: " ".repeat(padding) }, ...spans];
    case "center": {
      const leftPadding = Math.floor(padding / 2);
      const rightPadding = padding - leftPadding;
      return [
        { text: " ".repeat(leftPadding) },
        ...spans,
        { text: " ".repeat(rightPadding) }
      ];
    }
    case "left":
    default:
      return [...spans, { text: " ".repeat(padding) }];
  }
}

function measureSpansWidth(spans: MarkdownSpan[]): number {
  return spans.reduce((sum, span) => sum + measureStringWidth(span.text), 0);
}

function resolveTableColumnWidths(rows: MarkdownTableCell[][], maxWidth: number): number[] {
  const columnCount = rows[0]?.length ?? 0;
  const widths = Array.from({ length: columnCount }, () => 4);

  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      const cell = row[index];
      if (!cell) {
        continue;
      }

      widths[index] = Math.max(widths[index] ?? 4, measureStringWidth(cell.text), 4);
    }
  }

  let totalWidth = widths.reduce((sum, width) => sum + width, 0);
  while (totalWidth > maxWidth) {
    let adjusted = false;
    for (let index = 0; index < widths.length && totalWidth > maxWidth; index += 1) {
      if ((widths[index] ?? 4) <= 4) {
        continue;
      }

      widths[index] = (widths[index] ?? 4) - 1;
      totalWidth -= 1;
      adjusted = true;
    }

    if (!adjusted) {
      break;
    }
  }

  return widths;
}

function asTableCells(value: unknown): MarkdownTableCell[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((cell): cell is MarkdownToken => {
      return Boolean(cell && typeof cell === "object");
    })
    .map((cell) => {
      const spans = toInlineSpans(getInlineTokenSource(cell));
      return {
        text: spans.map((span) => span.text).join(""),
        align: asTableAlign(cell.align),
        spans,
        header: asBoolean(cell.header)
      };
    });
}

function asTableRows(value: unknown): MarkdownTableCell[][] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((row) => asTableCells(row));
}

function asTableAlign(value: unknown): "left" | "center" | "right" | null {
  return value === "left" || value === "center" || value === "right" ? value : null;
}

function isInlineBlockToken(token: MarkdownToken): boolean {
  return token.type === "paragraph" || token.type === "text" || token.type === "heading";
}

function getNestedTokens(token: MarkdownToken): MarkdownToken[] {
  return asTokenArray(token.tokens);
}

function getInlineTokenSource(token: MarkdownToken): MarkdownToken[] {
  const nestedTokens = getNestedTokens(token);
  return nestedTokens.length > 0 ? nestedTokens : fallbackTextTokenArray(token);
}

function fallbackTextTokenArray(token: MarkdownToken): MarkdownToken[] {
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

function getListItemPrefix(item: MarkdownToken): string {
  if (asBoolean(item.task)) {
    return `[${asBoolean(item.checked) ? "x" : " "}] `;
  }

  return "• ";
}

function clampHeadingDepth(depth: number | undefined): number {
  if (!depth || depth < 1) {
    return 1;
  }

  return Math.min(6, Math.trunc(depth));
}

function measureStringWidth(value: string): number {
  return Array.from(value).reduce((sum, character) => sum + measureCharWidth(character), 0);
}

function decodeCodeLiteral(value: string): string {
  return value.replace(/&(?:amp|#38|#x26);/gi, "&");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asTokenArray(value: unknown): MarkdownToken[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is MarkdownToken => {
    return Boolean(item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string");
  });
}
