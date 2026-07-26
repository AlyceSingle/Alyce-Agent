import { createReadStream } from "node:fs";
import { throwIfAborted } from "../../core/abort.js";
import type { TextFileEncoding } from "../internal/textFileIO.js";
import { formatBytes } from "./formatBytes.js";

export interface TextLineWindow {
  selectedLines: string[];
  totalLines: number;
  byteCapped: boolean;
  lineCapped: boolean;
}

export function createLineWindowFromContent(
  content: string,
  startLine: number,
  limit: number,
  maxLineChars: number,
  maxTextResultBytes: number
): TextLineWindow {
  const lines = splitTextLines(content);
  const selectedLines: string[] = [];
  const startIndex = Math.max(0, startLine - 1);
  const endIndexExclusive = Math.min(lines.length, startIndex + limit);
  let selectedBytes = 0;
  let byteCapped = false;
  let lineCapped = false;

  for (let index = startIndex; index < endIndexExclusive; index += 1) {
    const line = lines[index] ?? "";
    const lineTruncated = line.length > maxLineChars;
    const renderedLine = truncateLine(line, maxLineChars, lineTruncated);
    const nextLineBytes =
      Buffer.byteLength(renderedLine, "utf8") + (selectedLines.length > 0 ? 1 : 0);
    if (selectedBytes + nextLineBytes > maxTextResultBytes) {
      byteCapped = true;
      break;
    }

    lineCapped ||= lineTruncated;
    selectedLines.push(renderedLine);
    selectedBytes += nextLineBytes;
  }

  return {
    selectedLines,
    totalLines: lines.length,
    byteCapped,
    lineCapped
  };
}

export async function readLineWindow(
  absolutePath: string,
  startLine: number,
  limit: number,
  maxLineChars: number,
  maxTextResultBytes: number,
  encoding: TextFileEncoding,
  abortSignal?: AbortSignal
) {
  throwIfAborted(abortSignal);

  const selectedLines: string[] = [];
  const endLineExclusive = startLine + limit;
  const stream = createReadStream(absolutePath, {
    encoding
  });
  let totalLines = 0;
  let currentLine = 1;
  let currentSelectedLine = "";
  let currentSelectedLineTruncated = false;
  let hasPendingLine = false;
  let selectedBytes = 0;
  let byteCapped = false;
  let lineCapped = false;
  let isFirstChunk = true;

  const handleAbort = () => {
    stream.destroy(new Error("File read interrupted by user"));
  };

  if (abortSignal?.aborted) {
    handleAbort();
  } else {
    abortSignal?.addEventListener("abort", handleAbort, { once: true });
  }

  const isCurrentLineInRange = () => currentLine >= startLine && currentLine < endLineExclusive;

  const appendToCurrentLine = (fragment: string) => {
    if (fragment.length === 0) {
      return;
    }

    hasPendingLine = true;
    if (!isCurrentLineInRange() || byteCapped) {
      return;
    }

    const remainingChars = maxLineChars - currentSelectedLine.length;
    if (remainingChars <= 0) {
      currentSelectedLineTruncated = true;
      return;
    }

    if (fragment.length > remainingChars) {
      currentSelectedLine += fragment.slice(0, remainingChars);
      currentSelectedLineTruncated = true;
      return;
    }

    currentSelectedLine += fragment;
  };

  const finishCurrentLine = () => {
    if (isCurrentLineInRange() && !byteCapped) {
      const normalizedLine = currentSelectedLine.replace(/\r$/, "");
      const renderedLine = truncateLine(
        normalizedLine,
        maxLineChars,
        currentSelectedLineTruncated
      );
      const nextLineBytes =
        Buffer.byteLength(renderedLine, "utf8") + (selectedLines.length > 0 ? 1 : 0);
      if (selectedBytes + nextLineBytes > maxTextResultBytes) {
        byteCapped = true;
      } else {
        lineCapped ||= currentSelectedLineTruncated;
        selectedLines.push(renderedLine);
        selectedBytes += nextLineBytes;
      }
    }

    totalLines = currentLine;
    currentLine += 1;
    currentSelectedLine = "";
    currentSelectedLineTruncated = false;
    hasPendingLine = false;
  };

  try {
    for await (let chunk of stream) {
      throwIfAborted(abortSignal);

      if (isFirstChunk) {
        isFirstChunk = false;
        chunk = stripUtf8Bom(chunk);
      }

      if (chunk.includes("\u0000")) {
        throw new Error("Read only supports text-like files");
      }

      let startIndex = 0;
      let lineBreakIndex = chunk.indexOf("\n", startIndex);
      while (lineBreakIndex !== -1) {
        appendToCurrentLine(chunk.slice(startIndex, lineBreakIndex));
        finishCurrentLine();
        startIndex = lineBreakIndex + 1;
        lineBreakIndex = chunk.indexOf("\n", startIndex);
      }

      appendToCurrentLine(chunk.slice(startIndex));
    }

    if (hasPendingLine) {
      finishCurrentLine();
    }
  } finally {
    abortSignal?.removeEventListener("abort", handleAbort);
  }

  return {
    selectedLines,
    totalLines,
    byteCapped,
    lineCapped
  };
}

function splitTextLines(content: string) {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

export function stripUtf8Bom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function buildTextNotice(options: {
  totalLines: number;
  startLine: number;
  selectedLineCount: number;
  byteCapped: boolean;
  lineCapped: boolean;
  maxLineChars: number;
  maxTextResultBytes: number;
}) {
  if (options.totalLines === 0) {
    return undefined;
  }

  if (options.selectedLineCount === 0) {
    return undefined;
  }

  const lastLine = options.startLine + options.selectedLineCount - 1;
  const nextOffset = lastLine + 1;
  const lineCapSuffix = options.lineCapped
    ? ` One or more returned lines were truncated to ${options.maxLineChars} chars.`
    : "";

  if (options.byteCapped) {
    return `Output capped at ${formatBytes(options.maxTextResultBytes)} while reading lines ${options.startLine}-${lastLine}. Use offset=${nextOffset} to continue.${lineCapSuffix}`;
  }

  if (lastLine < options.totalLines) {
    return `Showing lines ${options.startLine}-${lastLine} of ${options.totalLines}. Use offset=${nextOffset} to continue.${lineCapSuffix}`;
  }

  return `End of file - total ${options.totalLines} lines.${lineCapSuffix}`;
}

export function renderWithLineNumbers(
  totalLines: number,
  startLine: number,
  lines: string[],
  notice?: string
): string {
  if (totalLines === 0) {
    return "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
  }

  if (lines.length === 0) {
    return `<system-reminder>Warning: offset ${startLine} is beyond file length (${totalLines} lines).</system-reminder>`;
  }

  const suffix = notice ? `\n\n<system-reminder>${notice}</system-reminder>` : "";

  return lines.map((line, index) => `${String(startLine + index).padStart(6, " ")}  ${line}`).join("\n") + suffix;
}

function truncateLine(line: string, maxLineChars: number, wasTruncated = false) {
  if (!wasTruncated && line.length <= maxLineChars) {
    return line;
  }

  return `${line.slice(0, maxLineChars)}... (line truncated to ${maxLineChars} chars)`;
}
