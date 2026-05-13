import type { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { withFileWriteLock } from "../internal/fileWriteLocks.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import { resolveWritablePathWithExternalApproval } from "../internal/externalDirectoryAccess.js";
import { requestFilePermission } from "../internal/filePermissions.js";
import { runPostWriteChecks } from "../internal/postWriteChecks.js";
import { ensureFreshFileRead, recordWrittenTextFile } from "../internal/readState.js";
import {
  countTextLines,
  readTextFileBytesWithMetadata,
  readTextFileWithMetadata,
  writeTextFileWithMetadata
} from "../internal/textFileIO.js";
import { assertExistingFileBytesUnchangedAfterApproval } from "../internal/writeSafety.js";
import type { ToolExecutionContext } from "../types.js";
import { FILE_EDIT_TOOL_NAME } from "./constants.js";
import { getEditToolDescription } from "./prompt.js";
import { type FileEditOutput, inputSchema } from "./types.js";
import { getPatchForEdit, resolveEditMatch } from "./utils.js";

export const FileEditInputSchema = inputSchema();
export const FILE_EDIT_TOOL_DESCRIPTION = getEditToolDescription();

export async function executeFileEdit(
  input: z.infer<typeof FileEditInputSchema>,
  context: ToolExecutionContext
): Promise<FileEditOutput> {
  // 统一先解析绝对路径；工作区外路径需先经过外部目录审批。
  const resolvedPath = await resolveEditPath(context, input.file_path);
  const fullFilePath = resolvedPath.absolutePath;
  const relativePath = toWorkspaceRelative(context.workspaceRoot, fullFilePath);

  return withFileWriteLock(fullFilePath, () =>
    executeFileEditLocked(input, context, fullFilePath, relativePath, resolvedPath.allowedRoots)
  );
}

async function executeFileEditLocked(
  input: z.infer<typeof FileEditInputSchema>,
  context: ToolExecutionContext,
  fullFilePath: string,
  relativePath: string,
  allowedRoots: readonly string[]
): Promise<FileEditOutput> {
  await ensureFreshFileRead(fullFilePath, context, FILE_EDIT_TOOL_NAME);

  const originalMetadata = await readTextFileBytesWithMetadata(fullFilePath);
  const originalFile = originalMetadata.content;
  if (input.old_string === input.new_string) {
    throw new Error("No changes to make: old_string and new_string are identical");
  }

  const match = resolveEditMatch(originalFile, input.old_string, Boolean(input.replace_all));

  const patchResult = getPatchForEdit({
    filePath: relativePath,
    fileContents: originalFile,
    oldString: match.actualOldString,
    newString: input.new_string,
    replaceAll: input.replace_all
  });

  if (patchResult.updatedFile === originalFile) {
    throw new Error("Edit produced no changes");
  }

  // 编辑落盘前走审批，确保高风险变更可中断。
  await requestFilePermission(context, fullFilePath, {
    toolName: FILE_EDIT_TOOL_NAME,
    title: "Edit file",
    permission: "file.edit",
    actionLabel: "edit file",
    details: [
      `Matches: ${match.matchCount}`,
      `Replace all: ${input.replace_all ? "yes" : "no"}`,
      `Match strategy: ${match.strategy}`
    ]
  });

  throwIfAborted(context.abortSignal);

  await assertExistingFileBytesUnchangedAfterApproval(fullFilePath, originalMetadata.rawBytes, {
    toolName: FILE_EDIT_TOOL_NAME,
    deletedRetryAction: "editing it",
    changedRetryAction: "modifying it"
  });

  await context.captureFileBeforeWrite(fullFilePath);
  await writeTextFileWithMetadata(fullFilePath, patchResult.updatedFile, {
    encoding: originalMetadata.encoding,
    hasBom: originalMetadata.hasBom,
    lineEndings: originalMetadata.lineEndings
  });
  const postWriteChecks = await runPostWriteChecks({
    absolutePath: fullFilePath,
    workspaceRoot: context.workspaceRoot,
    allowedRoots,
    abortSignal: context.abortSignal
  });
  const finalFile = (await readTextFileWithMetadata(fullFilePath)).content;
  const lineCount = countTextLines(finalFile);
  await recordWrittenTextFile(fullFilePath, relativePath, lineCount, context, finalFile);

  return {
    filePath: relativePath,
    oldString: input.old_string,
    newString: input.new_string,
    actualOldString: match.actualOldString,
    matchStrategy: match.strategy,
    structuredPatch:
      finalFile === patchResult.updatedFile
        ? patchResult.patch
        : getPatchForEdit({
            filePath: relativePath,
            fileContents: originalFile,
            oldString: originalFile,
            newString: finalFile,
            replaceAll: false
          }).patch,
    userModified: false,
    replaceAll: Boolean(input.replace_all),
    matchCount: match.matchCount,
    formatter: postWriteChecks.formatter,
    diagnostics: postWriteChecks.diagnostics
  };
}

async function resolveEditPath(
  context: ToolExecutionContext,
  filePath: string
): Promise<{
  absolutePath: string;
  allowedRoots: string[];
}> {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("Edit requires non-empty 'file_path'");
  }

  return resolveWritablePathWithExternalApproval(context, normalized, {
    toolName: FILE_EDIT_TOOL_NAME,
    title: "Edit external path",
    kind: "file"
  });
}
