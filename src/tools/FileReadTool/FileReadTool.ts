import { promises as fs } from "node:fs";
import type OpenAI from "openai";
import path from "node:path";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { createReadAttachmentMessage } from "../../core/api/generatedMessages.js";
import { requestSensitiveFileReadApproval } from "../internal/filePermissions.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import {
  detectTextFileEncoding,
  readTextFileWithMetadata
} from "../internal/textFileIO.js";
import { createToolResultEnvelope } from "../resultEnvelope.js";
import type { FileReadStateKind, ToolExecutionContext } from "../types.js";
import { isBinaryFile } from "./binaryDetection.js";
import { createDirectoryResult, listDirectoryEntries } from "./directoryRead.js";
import { formatBytes } from "./formatBytes.js";
import { readImageDimensions } from "./imageDimensions.js";
import { getDefaultFileReadingLimits } from "./limits.js";
import { createNotebookResult } from "./notebookRead.js";
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from "./prompt.js";
import {
  assertReadablePathCandidate,
  resolveReadPath,
  statReadPath
} from "./readPath.js";
import type {
  AssetReadResult,
  FileReadResult,
  FileUnchangedReadResult
} from "./results.js";
import {
  buildTextNotice,
  createLineWindowFromContent,
  readLineWindow,
  renderWithLineNumbers,
  stripUtf8Bom
} from "./textWindow.js";

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

export type {
  AssetReadResult,
  DirectoryReadResult,
  FileReadResult,
  FileTextReadResult,
  FileUnchangedReadResult,
  NotebookCellReadResult,
  NotebookReadResult
} from "./results.js";

export async function executeFileRead(
  input: z.infer<typeof FileReadInputSchema>,
  context: ToolExecutionContext
): Promise<FileReadResult | ReturnType<typeof createToolResultEnvelope>> {
  const limits = getDefaultFileReadingLimits();
  const requestedOffset = input.offset ?? 1;
  const absolutePath = await resolveReadPath(input.file_path, context);
  assertReadablePathCandidate(absolutePath);
  await requestSensitiveFileReadApproval(context, absolutePath, {
    toolName: FILE_READ_TOOL_NAME,
    actionLabel: "read file or directory"
  });
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

function isSameMtime(left: number, right: number) {
  return Math.abs(left - right) < 0.001;
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
