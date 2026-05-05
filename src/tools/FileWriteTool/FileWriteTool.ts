import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { withFileWriteLock } from "../internal/fileWriteLocks.js";
import { resolvePathFromInput, toWorkspaceRelative } from "../internal/pathSandbox.js";
import {
  runPostWriteChecks,
  type PostWriteChecksResult,
  type PostWriteDiagnosticsResult,
  type PostWriteFormatterResult
} from "../internal/postWriteChecks.js";
import { ensureFreshFileRead, recordWrittenTextFile } from "../internal/readState.js";
import {
  countTextLines,
  encodeTextFileContent,
  normalizeTextContent,
  readTextFileBytesWithMetadata,
  readTextFileWithMetadata,
  writeTextFileWithMetadata,
  type TextFileMetadata,
  type WriteLineEndingMode
} from "../internal/textFileIO.js";
import type { ToolExecutionContext } from "../types.js";
import {
  assertExistingFileBytesUnchangedAfterApproval,
  assertFileStillMissingAfterApproval
} from "../internal/writeSafety.js";
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from "./prompt.js";
import { getPatchForWrite, type StructuredPatchHunk } from "./utils.js";

export const FileWriteInputSchema = z
  .object({
    file_path: z
      .string()
      .describe(
        "Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths, on the local filesystem"
      ),
    content: z.string().describe("Full file content to write")
  })
  .strict();

export interface FileWriteResult {
  type: "create" | "update";
  filePath: string;
  bytes: number;
  lineCount: number;
  structuredPatch: StructuredPatchHunk[];
  formatter: PostWriteFormatterResult;
  diagnostics: PostWriteDiagnosticsResult;
}

export const FILE_WRITE_TOOL_DESCRIPTION = getWriteToolDescription();

export async function executeFileWrite(
  input: z.infer<typeof FileWriteInputSchema>,
  context: ToolExecutionContext
): Promise<FileWriteResult> {
  // 路径解析统一走工作区沙箱，避免写入越界。
  const fullFilePath = resolveWritePath(context.workspaceRoot, context.allowedRoots, input.file_path);
  const relativePath = toWorkspaceRelative(context.workspaceRoot, fullFilePath);

  return withFileWriteLock(fullFilePath, () =>
    executeFileWriteLocked(input, context, fullFilePath, relativePath)
  );
}

async function executeFileWriteLocked(
  input: z.infer<typeof FileWriteInputSchema>,
  context: ToolExecutionContext,
  fullFilePath: string,
  relativePath: string
): Promise<FileWriteResult> {
  const exists = await fileExists(fullFilePath);
  if (exists) {
    await ensureFreshFileRead(fullFilePath, context, FILE_WRITE_TOOL_NAME);
  }

  const mode: FileWriteResult["type"] = exists ? "update" : "create";
  const originalMetadata = exists ? await readTextFileBytesWithMetadata(fullFilePath) : null;
  const originalFile = originalMetadata?.content ?? "";
  const normalizedInputContent = normalizeTextContent(input.content);
  const writeOptions = {
    encoding: originalMetadata?.encoding ?? "utf8",
    hasBom: originalMetadata?.hasBom ?? false,
    lineEndings: resolveWriteLineEndings(input.content, originalMetadata)
  };
  const expectedWriteBytes = encodeTextFileContent(input.content, writeOptions);
  const byteSize = expectedWriteBytes.length;

  const approved = await context.requestApproval({
    kind: "file-write",
    toolName: FILE_WRITE_TOOL_NAME,
    title: `${mode === "create" ? "Create" : "Update"} file`,
    summary: relativePath,
    details: [`Mode: ${mode}`, `Size: ${byteSize} bytes`]
  });
  if (!approved) {
    throw new Error("User rejected Write tool request");
  }

  throwIfAborted(context.abortSignal);

  await assertTargetUnchangedAfterApproval(fullFilePath, exists, originalMetadata?.rawBytes);

  if (
    originalMetadata &&
    originalFile === normalizedInputContent &&
    originalMetadata.rawBytes.equals(expectedWriteBytes)
  ) {
    const currentStats = await fs.stat(fullFilePath);
    const currentLineCount = countTextLines(originalFile);
    await recordWrittenTextFile(fullFilePath, relativePath, currentLineCount, context, originalFile);
    const postWriteChecks = createSkippedPostWriteChecks(
      "Content already matched; no file write was performed."
    );
    return {
      type: mode,
      filePath: relativePath,
      bytes: currentStats.size,
      lineCount: currentLineCount,
      structuredPatch: getPatchForWrite({
        filePath: relativePath,
        originalFile,
        nextFile: originalFile
      }),
      formatter: postWriteChecks.formatter,
      diagnostics: postWriteChecks.diagnostics
    };
  }

  // 写入前确保父目录存在，兼容创建新文件场景。
  await context.captureFileBeforeWrite(fullFilePath);
  await fs.mkdir(path.dirname(fullFilePath), { recursive: true });
  await writeTextFileWithMetadata(fullFilePath, input.content, writeOptions);
  const postWriteChecks = await runPostWriteChecks({
    absolutePath: fullFilePath,
    workspaceRoot: context.workspaceRoot,
    allowedRoots: context.allowedRoots,
    abortSignal: context.abortSignal
  });
  const finalMetadata = await readTextFileWithMetadata(fullFilePath);
  const finalStats = await fs.stat(fullFilePath);
  const finalContent = finalMetadata.content;
  const finalByteSize = finalStats.size;
  const finalLineCount = countTextLines(finalContent);
  await recordWrittenTextFile(fullFilePath, relativePath, finalLineCount, context, finalContent);

  return {
    type: mode,
    filePath: relativePath,
    bytes: finalByteSize,
    lineCount: finalLineCount,
    structuredPatch: getPatchForWrite({
      filePath: relativePath,
      originalFile,
      nextFile: finalContent
    }),
    formatter: postWriteChecks.formatter,
    diagnostics: postWriteChecks.diagnostics
  };
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWritePath(
  workspaceRoot: string,
  allowedRoots: readonly string[],
  filePath: string
): string {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("Write requires non-empty 'file_path'");
  }

  return resolvePathFromInput(workspaceRoot, allowedRoots, normalized);
}

async function assertTargetUnchangedAfterApproval(
  fullFilePath: string,
  existedBeforeApproval: boolean,
  originalBytes: Buffer | undefined
): Promise<void> {
  if (!existedBeforeApproval) {
    await assertFileStillMissingAfterApproval(
      fullFilePath,
      "File was created while Write was awaiting approval. Use Read before updating it."
    );
    return;
  }

  if (!originalBytes) {
    throw new Error("Write lost its original file snapshot before approval completed.");
  }

  await assertExistingFileBytesUnchangedAfterApproval(fullFilePath, originalBytes, {
    toolName: FILE_WRITE_TOOL_NAME,
    deletedRetryAction: "writing it",
    changedRetryAction: "modifying it"
  });
}

function createSkippedPostWriteChecks(message: string): PostWriteChecksResult {
  return {
    formatter: {
      status: "skipped",
      message
    },
    diagnostics: {
      status: "skipped",
      issues: [],
      totalIssueCount: 0,
      truncated: false,
      message
    }
  };
}

function resolveWriteLineEndings(
  content: string,
  originalMetadata: TextFileMetadata | null
): WriteLineEndingMode {
  if (!originalMetadata || content.includes("\r\n")) {
    return "preserve";
  }

  return originalMetadata.lineEndings;
}
