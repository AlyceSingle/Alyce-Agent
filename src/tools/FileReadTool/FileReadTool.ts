import { createReadStream, promises as fs, type Dirent } from "node:fs";
import type OpenAI from "openai";
import path from "node:path";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { createReadAttachmentMessage } from "../../core/api/generatedMessages.js";
import { resolveReadablePathWithExternalApproval } from "../internal/externalDirectoryAccess.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import {
  detectTextFileEncoding,
  readTextFileWithMetadata,
  type TextFileEncoding
} from "../internal/textFileIO.js";
import { createToolResultEnvelope } from "../resultEnvelope.js";
import type { FileReadStateKind, ToolExecutionContext } from "../types.js";
import { getDefaultFileReadingLimits } from "./limits.js";
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from "./prompt.js";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp"
};

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".class",
  ".dat",
  ".dll",
  ".doc",
  ".docx",
  ".exe",
  ".gz",
  ".jar",
  ".lib",
  ".obj",
  ".o",
  ".odt",
  ".ods",
  ".odp",
  ".ppt",
  ".pptx",
  ".pyc",
  ".pyo",
  ".so",
  ".tar",
  ".war",
  ".wasm",
  ".xls",
  ".xlsx",
  ".zip"
]);

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2"
]);

const WINDOWS_BLOCKED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$"
]);

const MULTIMODAL_IMAGE_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);
const MAX_MULTIMODAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIMODAL_PDF_BYTES = 20 * 1024 * 1024;

export const FileReadInputSchema = z
  .object({
    file_path: z
      .string()
      .describe(
        "Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths, on the local filesystem"
      ),
    offset: positiveIntegerParameter(
      "Optional 1-based start line, directory entry, or notebook cell"
    ).optional(),
    limit: positiveIntegerParameter(
      "Optional number of lines, directory entries, or notebook cells to return"
    ).optional()
  })
  .strict();

function positiveIntegerParameter(description: string) {
  return z
    .preprocess((value) => {
      if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
      }

      return value;
    }, z.number().int().positive())
    .describe(description);
}

export interface FileTextReadResult {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
    truncated: boolean;
    nextOffset?: number;
    notice?: string;
  };
}

export interface DirectoryReadResult {
  type: "directory";
  directory: {
    directoryPath: string;
    entries: string[];
    startEntry: number;
    numEntries: number;
    totalEntries: number;
    truncated: boolean;
    nextOffset?: number;
    notice?: string;
  };
}

export interface NotebookCellReadResult {
  index: number;
  cellType: string;
  source: string;
  executionCount?: number | null;
  outputs?: string[];
}

export interface NotebookReadResult {
  type: "notebook";
  file: {
    filePath: string;
    summary: string;
    cells: NotebookCellReadResult[];
    numCells: number;
    startCell: number;
    totalCells: number;
    truncated: boolean;
    nextOffset?: number;
    notice?: string;
  };
}

export interface AssetReadResult {
  type: "image" | "pdf" | "binary";
  file: {
    filePath: string;
    mediaType: string;
    sizeBytes: number;
    visualReadSupported: boolean;
    message: string;
    dimensions?: {
      width: number;
      height: number;
    };
  };
}

export interface FileUnchangedReadResult {
  type: "file_unchanged";
  file: {
    filePath: string;
    message: string;
    previousKind: "text" | "notebook";
    offset: number;
    limit?: number;
  };
}

export type FileReadResult =
  | FileTextReadResult
  | DirectoryReadResult
  | NotebookReadResult
  | AssetReadResult
  | FileUnchangedReadResult;

export async function executeFileRead(
  input: z.infer<typeof FileReadInputSchema>,
  context: ToolExecutionContext
): Promise<FileReadResult | ReturnType<typeof createToolResultEnvelope>> {
  const limits = getDefaultFileReadingLimits();
  const requestedOffset = input.offset ?? 1;
  const absolutePath = await resolveReadPath(input.file_path, context);
  assertReadablePathCandidate(absolutePath);
  const displayPath = toWorkspaceRelative(context.workspaceRoot, absolutePath);
  const stats = await statReadPath(absolutePath, context.workspaceRoot);

  if (stats.isDirectory()) {
    const requestedLimit = input.limit ?? limits.defaultDirectoryEntries;
    if (requestedLimit > limits.maxDirectoryEntries) {
      throw new Error(
        `limit exceeds max allowed directory entries (${limits.maxDirectoryEntries})`
      );
    }

    const entries = await listDirectoryEntries(absolutePath);
    const result = createDirectoryResult(displayPath, entries, requestedOffset, requestedLimit);
    recordFileRead(context, absolutePath, {
      kind: "directory",
      source: "read",
      displayPath,
      readAt: new Date().toISOString(),
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      offset: requestedOffset,
      limit: requestedLimit,
      totalCount: entries.length,
      returnedCount: result.directory.numEntries,
      isPartial: requestedOffset !== 1 || result.directory.truncated
    });
    return result;
  }

  const extension = path.extname(absolutePath).toLowerCase();

  if (extension === ".ipynb") {
    const requestedLimit = input.limit ?? limits.defaultNotebookCells;
    if (requestedLimit > limits.maxNotebookCells) {
      throw new Error(`limit exceeds max allowed notebook cells (${limits.maxNotebookCells})`);
    }

    if (stats.size > limits.maxNotebookSizeBytes) {
      throw new Error(
        `Notebook is too large (${formatBytes(stats.size)}). Current notebook reads are capped at ${formatBytes(limits.maxNotebookSizeBytes)}.`
      );
    }

    const unchanged = createFileUnchangedResultIfCurrent(
      context,
      absolutePath,
      displayPath,
      stats,
      "notebook",
      requestedOffset,
      requestedLimit
    );
    if (unchanged) {
      return unchanged;
    }

    throwIfAborted(context.abortSignal);
    const notebookText = stripUtf8Bom(await fs.readFile(absolutePath, "utf8"));
    throwIfAborted(context.abortSignal);
    const result = createNotebookResult(displayPath, notebookText, requestedOffset, requestedLimit, limits);
    recordFileRead(context, absolutePath, {
      kind: "notebook",
      source: "read",
      displayPath,
      readAt: new Date().toISOString(),
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      offset: requestedOffset,
      limit: requestedLimit,
      totalCount: result.file.totalCells,
      returnedCount: result.file.numCells,
      isPartial: requestedOffset !== 1 || result.file.truncated
    });
    return result;
  }

  const imageMediaType = IMAGE_MEDIA_TYPES[extension];
  if (imageMediaType) {
    const dimensions = await readImageDimensions(absolutePath);
    if (!MULTIMODAL_IMAGE_MEDIA_TYPES.has(imageMediaType)) {
      return createAssetResult(context, absolutePath, displayPath, {
        kind: "image",
        mediaType: imageMediaType,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        dimensions,
        message:
          "Image detected, but this format is not currently inlined for multimodal analysis. Supported inline image formats are GIF, JPEG, PNG, and WEBP."
      });
    }

    if (stats.size > MAX_MULTIMODAL_IMAGE_BYTES) {
      return createAssetResult(context, absolutePath, displayPath, {
        kind: "image",
        mediaType: imageMediaType,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        dimensions,
        message:
          `Image detected, but Alyce will not inline it because ${formatBytes(stats.size)} exceeds the ${formatBytes(MAX_MULTIMODAL_IMAGE_BYTES)} image attachment cap.`
      });
    }

    throwIfAborted(context.abortSignal);
    const imageBuffer = await fs.readFile(absolutePath);
    throwIfAborted(context.abortSignal);
    const result = await createAssetResult(context, absolutePath, displayPath, {
      kind: "image",
      mediaType: imageMediaType,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      dimensions,
      visualReadSupported: true,
      message:
        "Image detected and attached as multimodal context for this turn. The model can inspect the actual pixels. Re-run Read if you need to resend it in a later turn."
    });

    return createToolResultEnvelope(result, [
      createReadAttachmentMessage([
        createAttachmentTextPart("image", displayPath),
        {
          type: "image_url",
          image_url: {
            url: `data:${imageMediaType};base64,${imageBuffer.toString("base64")}`,
            detail: "auto"
          }
        }
      ])
    ]);
  }

  if (extension === ".pdf") {
    if (stats.size > MAX_MULTIMODAL_PDF_BYTES) {
      return createAssetResult(context, absolutePath, displayPath, {
        kind: "pdf",
        mediaType: "application/pdf",
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        message:
          `PDF detected, but Alyce will not inline it because ${formatBytes(stats.size)} exceeds the ${formatBytes(MAX_MULTIMODAL_PDF_BYTES)} PDF attachment cap.`
      });
    }

    throwIfAborted(context.abortSignal);
    const pdfBuffer = await fs.readFile(absolutePath);
    throwIfAborted(context.abortSignal);
    const result = await createAssetResult(context, absolutePath, displayPath, {
      kind: "pdf",
      mediaType: "application/pdf",
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      visualReadSupported: true,
      message:
        "PDF detected and attached as multimodal context for this turn. The model can inspect the actual document. Re-run Read if you need to resend it in a later turn."
    });

    return createToolResultEnvelope(result, [
      createReadAttachmentMessage([
        createAttachmentTextPart("pdf", displayPath),
        {
          type: "file",
          file: {
            filename: path.basename(displayPath),
            file_data: `data:application/pdf;base64,${pdfBuffer.toString("base64")}`
          }
        }
      ])
    ]);
  }

  const textEncoding = await detectTextFileEncoding(absolutePath);
  if (await isBinaryFile(absolutePath, stats.size, textEncoding)) {
    return createAssetResult(context, absolutePath, displayPath, {
      kind: "binary",
      mediaType: "application/octet-stream",
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      message:
        "Binary file detected. Read returns metadata only for this file type. Use Bash, PowerShell, or a specialized parser if you need deeper inspection."
    });
  }

  const requestedLimit = input.limit ?? limits.maxLines;
  if (requestedLimit > limits.maxLines) {
    throw new Error(`limit exceeds max allowed lines (${limits.maxLines})`);
  }

  if (input.limit === undefined && stats.size > limits.maxSizeBytes) {
    throw new Error(
      `File is too large (${formatBytes(stats.size)}). Please provide offset and limit for partial reads.`
    );
  }

  const unchanged = createFileUnchangedResultIfCurrent(
    context,
    absolutePath,
    displayPath,
    stats,
    "text",
    requestedOffset,
    requestedLimit
  );
  if (unchanged) {
    return unchanged;
  }

  const fullTextMetadata = stats.size <= limits.maxSizeBytes
    ? await readTextFileWithMetadata(absolutePath)
    : null;
  throwIfAborted(context.abortSignal);

  const lineWindow = fullTextMetadata
    ? createLineWindowFromContent(
        fullTextMetadata.content,
        requestedOffset,
        requestedLimit,
        limits.maxLineChars,
        limits.maxTextResultBytes
      )
    : await readLineWindow(
        absolutePath,
        requestedOffset,
        requestedLimit,
        limits.maxLineChars,
        limits.maxTextResultBytes,
        textEncoding,
        context.abortSignal
      );
  const { selectedLines, totalLines, byteCapped, lineCapped } = lineWindow;
  const hasContinuation =
    selectedLines.length > 0 &&
    (requestedOffset + selectedLines.length - 1 < totalLines || byteCapped);
  const truncated = hasContinuation || lineCapped;
  const notice = buildTextNotice({
    totalLines,
    startLine: requestedOffset,
    selectedLineCount: selectedLines.length,
    byteCapped,
    lineCapped,
    maxLineChars: limits.maxLineChars,
    maxTextResultBytes: limits.maxTextResultBytes
  });
  const rendered = renderWithLineNumbers(totalLines, requestedOffset, selectedLines, notice);
  const isPartial = requestedOffset !== 1 || selectedLines.length < totalLines || byteCapped || lineCapped;
  recordFileRead(context, absolutePath, {
    kind: "text",
    source: "read",
    displayPath,
    readAt: new Date().toISOString(),
    mtimeMs: stats.mtimeMs,
    sizeBytes: stats.size,
    offset: requestedOffset,
    limit: requestedLimit,
    totalCount: totalLines,
    returnedCount: selectedLines.length,
    isPartial,
    content: isPartial ? undefined : fullTextMetadata?.content
  });

  return {
    type: "text",
    file: {
      filePath: displayPath,
      content: rendered,
      numLines: selectedLines.length,
      startLine: requestedOffset,
      totalLines,
      truncated,
      nextOffset: hasContinuation ? requestedOffset + selectedLines.length : undefined,
      notice
    }
  };
}

interface TextLineWindow {
  selectedLines: string[];
  totalLines: number;
  byteCapped: boolean;
  lineCapped: boolean;
}

function createLineWindowFromContent(
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

async function readLineWindow(
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

function createFileUnchangedResultIfCurrent(
  context: ToolExecutionContext,
  absolutePath: string,
  displayPath: string,
  stats: {
    mtimeMs: number;
    size: number;
  },
  expectedKind: "text" | "notebook",
  offset: number,
  limit: number | undefined
): FileUnchangedReadResult | undefined {
  const existingState = context.getFileReadState(absolutePath);
  if (!existingState) {
    return undefined;
  }

  if (
    existingState.source !== "read" ||
    existingState.kind !== expectedKind ||
    existingState.offset !== offset ||
    existingState.limit !== limit
  ) {
    return undefined;
  }

  if (existingState.mtimeMs !== undefined && !isSameMtime(existingState.mtimeMs, stats.mtimeMs)) {
    return undefined;
  }

  if (existingState.sizeBytes !== undefined && existingState.sizeBytes !== stats.size) {
    return undefined;
  }

  return {
    type: "file_unchanged",
    file: {
      filePath: displayPath,
      message: FILE_UNCHANGED_STUB,
      previousKind: expectedKind,
      offset,
      ...(limit !== undefined ? { limit } : {})
    }
  };
}

function stripUtf8Bom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isSameMtime(left: number, right: number) {
  return Math.abs(left - right) < 0.001;
}

async function resolveReadPath(
  filePath: string,
  context: ToolExecutionContext
): Promise<string> {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("Read requires non-empty 'file_path'");
  }

  const resolved = await resolveReadablePathWithExternalApproval(context, normalized, {
    toolName: FILE_READ_TOOL_NAME,
    title: "Read external path",
    kind: "file-or-directory"
  });
  return resolved.absolutePath;
}

function assertReadablePathCandidate(absolutePath: string) {
  if (isBlockedDevicePath(absolutePath)) {
    throw new Error(`Read cannot open ${absolutePath} because this device path would block or stream endlessly.`);
  }
}

function isBlockedDevicePath(absolutePath: string) {
  if (isWindowsDevicePath(absolutePath)) {
    return true;
  }

  if (BLOCKED_DEVICE_PATHS.has(absolutePath)) {
    return true;
  }

  return (
    absolutePath.startsWith("/proc/") &&
    (absolutePath.endsWith("/fd/0") ||
      absolutePath.endsWith("/fd/1") ||
      absolutePath.endsWith("/fd/2"))
  );
}

function isWindowsDevicePath(absolutePath: string) {
  if (process.platform !== "win32") {
    return false;
  }

  const basename = path.basename(absolutePath).replace(/[. ]+$/g, "");
  const deviceName = basename.split(".")[0]?.toUpperCase() ?? "";
  return (
    WINDOWS_BLOCKED_DEVICE_NAMES.has(deviceName) ||
    /^COM[1-9]$/.test(deviceName) ||
    /^LPT[1-9]$/.test(deviceName)
  );
}

async function statReadPath(absolutePath: string, workspaceRoot: string) {
  try {
    return await fs.stat(absolutePath);
  } catch (error) {
    if (isEnoentError(error)) {
      throw new Error(await buildMissingPathMessage(absolutePath, workspaceRoot));
    }

    throw error;
  }
}

async function buildMissingPathMessage(absolutePath: string, workspaceRoot: string) {
  const suggestions = await findPathSuggestions(absolutePath, workspaceRoot);
  const missingPath = toWorkspaceRelative(workspaceRoot, absolutePath);
  if (suggestions.length === 0) {
    return `Path not found: ${missingPath}`;
  }

  return `Path not found: ${missingPath}\n\nDid you mean one of these?\n${suggestions
    .map((suggestion) => `- ${suggestion}`)
    .join("\n")}`;
}

async function findPathSuggestions(absolutePath: string, workspaceRoot: string) {
  const nearestDirectory = await findNearestExistingDirectory(path.dirname(absolutePath));
  if (!nearestDirectory) {
    return [];
  }

  const targetBase = path.basename(absolutePath).toLowerCase();
  try {
    const entries = await fs.readdir(nearestDirectory, { withFileTypes: true });
    return entries
      .map((entry) => ({
        label: entry.isDirectory() ? `${entry.name}/` : entry.name,
        absolute: path.join(nearestDirectory, entry.name),
        score: scorePathSuggestion(targetBase, entry.name.toLowerCase())
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
      .slice(0, 3)
      .map((entry) => {
        const display = toWorkspaceRelative(workspaceRoot, entry.absolute);
        return entry.label.endsWith("/") && !display.endsWith("/") ? `${display}/` : display;
      });
  } catch {
    return [];
  }
}

async function findNearestExistingDirectory(directoryPath: string): Promise<string | null> {
  let currentPath = path.resolve(directoryPath);

  while (true) {
    try {
      const stats = await fs.stat(currentPath);
      if (stats.isDirectory()) {
        return currentPath;
      }
    } catch {}

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

function scorePathSuggestion(targetBase: string, candidate: string) {
  if (!targetBase || !candidate) {
    return 0;
  }

  if (candidate === targetBase) {
    return 100;
  }

  if (candidate.startsWith(targetBase) || targetBase.startsWith(candidate)) {
    return 80;
  }

  if (candidate.includes(targetBase) || targetBase.includes(candidate)) {
    return 60;
  }

  const targetStem = stripExtension(targetBase);
  const candidateStem = stripExtension(candidate);
  if (
    targetStem.length > 0 &&
    candidateStem.length > 0 &&
    (candidateStem.includes(targetStem) || targetStem.includes(candidateStem))
  ) {
    return 40;
  }

  return 0;
}

function stripExtension(value: string) {
  const extension = path.extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function isEnoentError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function buildTextNotice(options: {
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

function renderWithLineNumbers(
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

  return lines.map((line, index) => `${String(startLine + index).padStart(6, " ")}\t${line}`).join("\n") + suffix;
}

async function listDirectoryEntries(absolutePath: string): Promise<string[]> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const normalizedEntries = await Promise.all(
    entries.map((entry) => normalizeDirectoryEntry(absolutePath, entry))
  );

  return normalizedEntries
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }

      return left.label.localeCompare(right.label, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    })
    .map((entry) => entry.label);
}

async function normalizeDirectoryEntry(absolutePath: string, entry: Dirent) {
  if (entry.isDirectory()) {
    return {
      label: `${entry.name}/`,
      rank: 0
    };
  }

  if (entry.isSymbolicLink()) {
    try {
      const stats = await fs.stat(path.join(absolutePath, entry.name));
      if (stats.isDirectory()) {
        return {
          label: `${entry.name}/`,
          rank: 0
        };
      }
    } catch {
      return {
        label: `${entry.name}@`,
        rank: 2
      };
    }
  }

  return {
    label: entry.name,
    rank: 1
  };
}

function createDirectoryResult(
  directoryPath: string,
  entries: string[],
  startEntry: number,
  limit: number
): DirectoryReadResult {
  const startIndex = startEntry - 1;
  const selectedEntries = entries.slice(startIndex, startIndex + limit);
  const truncated = startIndex + selectedEntries.length < entries.length;

  return {
    type: "directory",
    directory: {
      directoryPath,
      entries: selectedEntries,
      startEntry,
      numEntries: selectedEntries.length,
      totalEntries: entries.length,
      truncated,
      nextOffset: truncated ? startEntry + selectedEntries.length : undefined,
      notice: buildDirectoryNotice(entries.length, startEntry, selectedEntries.length)
    }
  };
}

function buildDirectoryNotice(totalEntries: number, startEntry: number, numEntries: number) {
  if (totalEntries === 0) {
    return "Directory is empty.";
  }

  if (numEntries === 0) {
    return `offset ${startEntry} is beyond directory length (${totalEntries} entries).`;
  }

  return undefined;
}

function createNotebookResult(
  filePath: string,
  notebookText: string,
  startCell: number,
  limit: number,
  limits: ReturnType<typeof getDefaultFileReadingLimits>
): NotebookReadResult {
  let parsedNotebook: unknown;
  try {
    parsedNotebook = JSON.parse(notebookText) as unknown;
  } catch {
    throw new Error("Notebook file is not valid JSON");
  }

  const notebookRecord = asRecord(parsedNotebook);
  if (!notebookRecord) {
    throw new Error("Notebook file does not contain a valid top-level object");
  }

  const cells = Array.isArray(notebookRecord.cells) ? notebookRecord.cells : [];
  const startIndex = startCell - 1;
  const selectedCells = cells.slice(startIndex, startIndex + limit);
  const summarizedCells = selectedCells.map((cell, index) =>
    summarizeNotebookCell(cell, startIndex + index + 1, limits)
  );
  const truncated = startIndex + summarizedCells.length < cells.length;

  return {
    type: "notebook",
    file: {
      filePath,
      summary: buildNotebookSummary(notebookRecord, cells),
      cells: summarizedCells,
      numCells: summarizedCells.length,
      startCell,
      totalCells: cells.length,
      truncated,
      nextOffset: truncated ? startCell + summarizedCells.length : undefined,
      notice: buildNotebookNotice(cells.length, startCell, summarizedCells.length)
    }
  };
}

function buildNotebookSummary(notebook: Record<string, unknown>, cells: unknown[]) {
  let codeCells = 0;
  let markdownCells = 0;
  let rawCells = 0;

  for (const cell of cells) {
    const record = asRecord(cell);
    const cellType = asString(record?.cell_type);
    if (cellType === "code") {
      codeCells += 1;
    } else if (cellType === "markdown") {
      markdownCells += 1;
    } else if (cellType === "raw") {
      rawCells += 1;
    }
  }

  const metadata = asRecord(notebook.metadata);
  const languageInfo = asRecord(metadata?.language_info);
  const kernelSpec = asRecord(metadata?.kernelspec);
  const language = asString(languageInfo?.name);
  const kernel = asString(kernelSpec?.display_name);
  const summaryParts = [
    `Notebook with ${cells.length} cells`,
    `${codeCells} code`,
    `${markdownCells} markdown`,
    `${rawCells} raw`
  ];

  if (language) {
    summaryParts.push(`language: ${language}`);
  }

  if (kernel) {
    summaryParts.push(`kernel: ${kernel}`);
  }

  return summaryParts.join(", ");
}

function buildNotebookNotice(totalCells: number, startCell: number, numCells: number) {
  if (totalCells === 0) {
    return "Notebook has no cells.";
  }

  if (numCells === 0) {
    return `offset ${startCell} is beyond notebook length (${totalCells} cells).`;
  }

  return undefined;
}

function summarizeNotebookCell(
  cell: unknown,
  index: number,
  limits: ReturnType<typeof getDefaultFileReadingLimits>
): NotebookCellReadResult {
  const record = asRecord(cell);
  const cellType = asString(record?.cell_type) ?? "unknown";
  const source = truncateNotebookText(readNotebookMultilineValue(record?.source), limits.maxNotebookCellChars);
  const executionCount = asNullableNumber(record?.execution_count);
  const rawOutputs = Array.isArray(record?.outputs) ? record.outputs : [];
  const outputs = rawOutputs
    .slice(0, limits.maxNotebookOutputsPerCell)
    .map((output) => truncateNotebookText(renderNotebookOutput(output), limits.maxNotebookOutputChars))
    .filter((output) => output.length > 0);

  if (rawOutputs.length > limits.maxNotebookOutputsPerCell) {
    outputs.push(`... ${rawOutputs.length - limits.maxNotebookOutputsPerCell} more outputs omitted`);
  }

  return {
    index,
    cellType,
    source,
    ...(cellType === "code" ? { executionCount } : {}),
    ...(outputs.length > 0 ? { outputs } : {})
  };
}

function readNotebookMultilineValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join("");
  }

  return "";
}

function renderNotebookOutput(output: unknown): string {
  const record = asRecord(output);
  if (!record) {
    return "";
  }

  const outputType = asString(record.output_type);
  if (outputType === "stream") {
    return readNotebookMultilineValue(record.text);
  }

  if (outputType === "error") {
    const traceback = Array.isArray(record.traceback)
      ? record.traceback.filter((line): line is string => typeof line === "string").join("\n")
      : "";
    const ename = asString(record.ename);
    const evalue = asString(record.evalue);
    return [ename, evalue].filter(Boolean).join(": ") + (traceback ? `\n${traceback}` : "");
  }

  if (outputType === "display_data" || outputType === "execute_result") {
    const data = asRecord(record.data);
    if (!data) {
      return "";
    }

    const plainText = readNotebookMultilineValue(data["text/plain"]);
    if (plainText) {
      return plainText;
    }

    const keys = Object.keys(data);
    if (keys.length > 0) {
      return `[rich output: ${keys.join(", ")}]`;
    }
  }

  if ("text" in record) {
    return readNotebookMultilineValue(record.text);
  }

  return truncateNotebookText(formatUnknownValue(output), 400);
}

function truncateNotebookText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...<truncated ${value.length - maxChars} chars>`;
}

async function readImageDimensions(absolutePath: string) {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return parseImageDimensions(buffer.subarray(0, result.bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function parseImageDimensions(buffer: Buffer) {
  return (
    parsePngDimensions(buffer) ??
    parseGifDimensions(buffer) ??
    parseJpegDimensions(buffer) ??
    parseBmpDimensions(buffer) ??
    parseIcoDimensions(buffer) ??
    parseWebpDimensions(buffer)
  );
}

function parsePngDimensions(buffer: Buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return undefined;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function parseGifDimensions(buffer: Buffer) {
  if (buffer.length < 10) {
    return undefined;
  }

  const header = buffer.subarray(0, 6).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") {
    return undefined;
  }

  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8)
  };
}

function parseBmpDimensions(buffer: Buffer) {
  if (buffer.length < 26 || buffer.subarray(0, 2).toString("ascii") !== "BM") {
    return undefined;
  }

  return {
    width: Math.abs(buffer.readInt32LE(18)),
    height: Math.abs(buffer.readInt32LE(22))
  };
}

function parseIcoDimensions(buffer: Buffer) {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    return undefined;
  }

  return {
    width: buffer[6] === 0 ? 256 : buffer[6],
    height: buffer[7] === 0 ? 256 : buffer[7]
  };
}

function parseWebpDimensions(buffer: Buffer) {
  if (buffer.length < 30) {
    return undefined;
  }

  if (
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return undefined;
  }

  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }

  if (chunkType === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  return undefined;
}

function parseJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      return undefined;
    }

    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5)
      };
    }

    offset += 2 + segmentLength;
  }

  return undefined;
}

async function createAssetResult(
  context: ToolExecutionContext,
  absolutePath: string,
  filePath: string,
  options: {
    kind: Extract<FileReadStateKind, "image" | "pdf" | "binary">;
    mediaType: string;
    sizeBytes: number;
    mtimeMs: number;
    message: string;
    visualReadSupported?: boolean;
    dimensions?: {
      width: number;
      height: number;
    };
  }
): Promise<AssetReadResult> {
  recordFileRead(context, absolutePath, {
    kind: options.kind,
    source: "read",
    displayPath: filePath,
    readAt: new Date().toISOString(),
    mtimeMs: options.mtimeMs,
    sizeBytes: options.sizeBytes,
    isPartial: true
  });

  return {
    type: options.kind,
    file: {
      filePath,
      mediaType: options.mediaType,
      sizeBytes: options.sizeBytes,
      visualReadSupported: options.visualReadSupported ?? false,
      message: options.message,
      ...(options.dimensions ? { dimensions: options.dimensions } : {})
    }
  };
}

function createAttachmentTextPart(
  assetKind: "image" | "pdf",
  filePath: string
): OpenAI.Chat.Completions.ChatCompletionContentPartText {
  return {
    type: "text",
    text: [
      "System-generated multimodal attachment from the Read tool.",
      `Attached ${assetKind}: ${filePath}`,
      "This is not a new user request.",
      "Use this attachment as context for the immediately preceding tool result and continue the current task."
    ].join("\n")
  };
}

function recordFileRead(
  context: ToolExecutionContext,
  absolutePath: string,
  state: Parameters<ToolExecutionContext["recordFileRead"]>[1]
) {
  context.recordFileRead(absolutePath, state);
}

function truncateLine(line: string, maxLineChars: number, wasTruncated = false) {
  if (!wasTruncated && line.length <= maxLineChars) {
    return line;
  }

  return `${line.slice(0, maxLineChars)}... (line truncated to ${maxLineChars} chars)`;
}

async function isBinaryFile(
  absolutePath: string,
  fileSize: number,
  textEncoding: TextFileEncoding
): Promise<boolean> {
  const extension = path.extname(absolutePath).toLowerCase();
  if (KNOWN_BINARY_EXTENSIONS.has(extension)) {
    return true;
  }

  if (textEncoding === "utf16le") {
    return false;
  }

  if (fileSize === 0) {
    return false;
  }

  const handle = await fs.open(absolutePath, "r");
  try {
    const sampleSize = Math.min(4096, fileSize);
    const bytes = Buffer.alloc(sampleSize);
    const result = await handle.read(bytes, 0, sampleSize, 0);
    if (result.bytesRead === 0) {
      return false;
    }

    let nonPrintableCount = 0;
    for (let index = 0; index < result.bytesRead; index += 1) {
      if (bytes[index] === 0) {
        return true;
      }

      if (bytes[index] < 9 || (bytes[index] > 13 && bytes[index] < 32)) {
        nonPrintableCount += 1;
      }
    }

    return nonPrintableCount / result.bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatUnknownValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
