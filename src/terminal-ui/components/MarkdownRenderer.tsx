import React from "react";
import { asNumber, asString } from "../../core/util/unknown.js";
import { createHash } from "node:crypto";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import type { TerminalUiMessageKind } from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { normalizeMarkdownInput } from "../utils/htmlEntities.js";
import { streamMarkdownForRender } from "../utils/markdownStream.js";
import { splitMarkdownMathSegments } from "../utils/math.js";
import { renderCodeBlock, renderRawBlock } from "./markdown/blocks.js";
import { toInlineSpans } from "./markdown/inline.js";
import { markdownLexer } from "./markdown/lexer.js";
import {
  buildBlocksFromMathSegments,
  renderInlineContentWithMath
} from "./markdown/mathBlocks.js";
import { assertWithinParseBudget } from "./markdown/parseBudget.js";
import { createWrappedSpanBlock, measureStringWidth } from "./markdown/spans.js";
import { renderTableBlock } from "./markdown/table.js";
import {
  asBoolean,
  asTokenArray,
  clampHeadingDepth,
  fallbackTextTokenArray,
  getInlineTokenSource,
  getListItemPrefix,
  getNestedTokens,
  isInlineBlockToken
} from "./markdown/tokens.js";
import type {
  BuildMarkdownRenderPlanOptions,
  MarkdownLineVariant,
  MarkdownRenderBlock,
  MarkdownRenderLine,
  MarkdownRenderPlan,
  MarkdownSpan,
  MarkdownSpanStyle,
  MarkdownToken
} from "./markdown/types.js";

export type {
  BuildMarkdownRenderPlanOptions,
  MarkdownRenderBlock,
  MarkdownRenderLine,
  MarkdownRenderPlan
} from "./markdown/types.js";

const MAX_MARKDOWN_PLAN_CACHE_ENTRIES = 128;
const DEFAULT_RENDER_POLICY_VERSION = "legacy";
const MAX_MARKDOWN_STREAM_BLOCKS = 512;
const markdownPlanCache = new Map<string, MarkdownRenderPlan>();

export function buildMarkdownRenderPlan(
  content: string,
  width: number,
  options: BuildMarkdownRenderPlanOptions = {}
): MarkdownRenderPlan {
  const safeWidth = Math.max(16, width);
  const mode = options.live === true ? "live" : "full";
  const policyVersion = options.policyVersion?.trim() || DEFAULT_RENDER_POLICY_VERSION;
  const normalizedInput = normalizeMarkdownInput(content, { decodeEntities: false });
  const preparedInput = normalizedInput.trim().length > 0 ? normalizedInput : "(empty)";
  assertWithinParseBudget(preparedInput);
  const streamBlocks = streamMarkdownForRender(preparedInput, options.live === true);
  if (streamBlocks.length > MAX_MARKDOWN_STREAM_BLOCKS) {
    throw new Error(
      `Markdown stream block budget exceeded: ${streamBlocks.length}/${MAX_MARKDOWN_STREAM_BLOCKS}`
    );
  }

  const cacheKey = buildMarkdownPlanCacheKey(
    streamBlocks.map((block) => block.src),
    safeWidth,
    mode,
    policyVersion
  );
  const cachedPlan = markdownPlanCache.get(cacheKey);
  if (cachedPlan) {
    markdownPlanCache.delete(cacheKey);
    markdownPlanCache.set(cacheKey, cachedPlan);
    return cachedPlan;
  }

  const blocks = renderStreamBlocks(streamBlocks, safeWidth);
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

function renderStreamBlocks(streamBlocks: Array<{ src: string }>, width: number) {
  const blocks: MarkdownRenderBlock[] = [];

  for (let index = 0; index < streamBlocks.length; index += 1) {
    const streamBlock = streamBlocks[index];
    if (!streamBlock) {
      continue;
    }

    const tokens = markdownLexer.lexer(streamBlock.src) as MarkdownToken[];
    const rendered = renderBlockTokens(tokens, width, `md-${index}`, 0);
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

function buildMarkdownPlanCacheKey(
  sources: string[],
  width: number,
  mode: "live" | "full",
  policyVersion: string
) {
  const digest = createHash("sha1");
  digest.update(mode);
  digest.update("\u0000");
  digest.update(policyVersion);
  digest.update("\u0000");
  for (const source of sources) {
    digest.update(source);
    digest.update("\u0001");
  }

  return `${width}:${mode}:${policyVersion}:${digest.digest("hex")}`;
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
  colorMode?: "semantic" | "plain";
}) {
  const plainColor = props.colorMode === "plain"
    ? props.baseColor ?? terminalUiTheme.colors.messageCardText
    : undefined;

  return (
    <Box flexDirection="column" width="100%">
      {props.plan.blocks.map((block) => (
        <Box key={block.key} flexDirection="column" marginTop={block.marginTop} width="100%">
          {block.lines.map((line) => {
            const lineStyle = getLineStyle(line.variant, props.kind, props.baseColor, line.quoteDepth);
            const textStyle = plainColor ? { ...lineStyle, color: plainColor } : lineStyle;

            return (
              <Text
                key={line.key}
                {...buildInkTextProps(textStyle)}
              >
                {renderLineContent(line, plainColor)}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function renderLineContent(line: MarkdownRenderLine, plainColor?: string) {
  const prefixText = `${" ".repeat(Math.max(0, line.indent))}${line.prefix}`;

  if (line.spans.length === 0) {
    return prefixText || " ";
  }

  return (
    <>
      {prefixText}
      {line.spans.map((span, index) => (
        <React.Fragment key={`${line.key}-span-${index}`}>
          {renderSpan(span, plainColor)}
        </React.Fragment>
      ))}
    </>
  );
}

function getLineStyle(
  variant: MarkdownLineVariant,
  kind: TerminalUiMessageKind,
  baseColor: string | undefined,
  quoteDepth = 0
): MarkdownSpanStyle {
  const defaultColor = kind === "thinking"
    ? terminalUiTheme.colors.thinkingMarkdownText
    : (baseColor ?? terminalUiTheme.colors.messageCardText);

  switch (variant) {
    case "heading-1":
      return {
        color: terminalUiTheme.colors.markdownHeading1,
        bold: true,
        underline: true
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
      if (quoteDepth >= 3) {
        return {
          color: terminalUiTheme.colors.markdownQuoteDeep
        };
      }

      if (quoteDepth >= 2) {
        return {
          color: terminalUiTheme.colors.markdownQuoteNested
        };
      }

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
    case "math":
      return {
        color: terminalUiTheme.colors.markdownInlineCode,
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
    case "table-divider":
      return {
        color: terminalUiTheme.colors.markdownTableDivider
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
          variant: `heading-${Math.min(depth, 4)}` as MarkdownLineVariant
        })
      ];
    }
    case "paragraph":
    case "text":
      return renderParagraphLikeToken(token, width, key, baseIndent, "paragraph");
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

      return renderParagraphLikeContent(fallbackText, width, key, baseIndent, "paragraph");
    }
  }
}

function renderParagraphLikeToken(
  token: MarkdownToken,
  width: number,
  key: string,
  baseIndent: number,
  variant: Extract<MarkdownLineVariant, "paragraph" | "quote" | "list">
): MarkdownRenderBlock[] {
  const inlineSource = getInlineTokenSource(token);
  return renderInlineContentWithMath(
    inlineSource,
    width,
    key,
    baseIndent,
    variant
  );
}

function renderParagraphLikeContent(
  content: string,
  width: number,
  key: string,
  baseIndent: number,
  variant: Extract<MarkdownLineVariant, "paragraph" | "quote" | "list">
): MarkdownRenderBlock[] {
  return buildBlocksFromMathSegments(
    splitMarkdownMathSegments(content),
    width,
    key,
    baseIndent,
    variant
  );
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
        ...renderInlineContentWithMath(
          getInlineTokenSource(firstToken),
          width,
          `${itemKey}-head`,
          baseIndent,
          "list",
          prefix,
          continuationPrefix
        )
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
        ...buildBlocksFromMathSegments(
          splitMarkdownMathSegments(fallbackText || " "),
          width,
          `${itemKey}-fallback`,
          baseIndent,
          "list",
          prefix,
          continuationPrefix
        )
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
      quoteDepth:
        line.variant === "code" || line.variant === "code-label"
          ? line.quoteDepth
          : (line.quoteDepth ?? 0) + 1,
      variant:
        line.variant === "code" || line.variant === "code-label" ? line.variant : "quote"
    }))
  }));
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

function renderSpan(span: MarkdownSpan, plainColor?: string) {
  const style = plainColor ? { ...span, color: plainColor } : span;
  const node = <Text {...buildInkTextProps(style)}>{span.text}</Text>;
  if (!span.href) {
    return node;
  }

  return React.createElement("ink-link", { href: span.href }, node);
}
