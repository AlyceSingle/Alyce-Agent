import { terminalUiTheme } from "../../theme/theme.js";
import { renderRawBlock } from "./blocks.js";
import { toInlineSpans } from "./inline.js";
import { asBoolean, getInlineTokenSource } from "./tokens.js";
import {
  applySpanStyle,
  measureSpansWidth,
  measureStringWidth,
  wrapSpans
} from "./spans.js";
import type {
  MarkdownLineVariant,
  MarkdownRenderBlock,
  MarkdownRenderLine,
  MarkdownSpan,
  MarkdownTableCell,
  MarkdownToken
} from "./types.js";

export function renderTableBlock(
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
    variant: "table-divider"
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
