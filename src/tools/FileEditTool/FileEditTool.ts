import type { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { withFileWriteLock } from "../internal/fileWriteLocks.js";
import { resolvePathFromInput, toWorkspaceRelative } from "../internal/pathSandbox.js";
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
  // 统一先解析为工作区内绝对路径，后续读写都基于同一路径。
  const fullFilePath = resolveEditPath(context.workspaceRoot, context.allowedRoots, input.file_path);
  const relativePath = toWorkspaceRelative(context.workspaceRoot, fullFilePath);

  return withFileWriteLock(fullFilePath, () =>
    executeFileEditLocked(input, context, fullFilePath, relativePath)
  );
}

async function executeFileEditLocked(
  input: z.infer<typeof FileEditInputSchema>,
  context: ToolExecutionContext,
  fullFilePath: string,
  relativePath: string
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
  const approved = await context.requestApproval({
    kind: "file-write",
    toolName: FILE_EDIT_TOOL_NAME,
    title: "Edit file",
    summary: relativePath,
    details: [
      `Matches: ${match.matchCount}`,
      `Replace all: ${input.replace_all ? "yes" : "no"}`,
      `Match strategy: ${match.strategy}`
    ]
  });
  if (!approved) {
    throw new Error("User rejected Edit tool request");
  }

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
    allowedRoots: context.allowedRoots,
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

function resolveEditPath(
  workspaceRoot: string,
  allowedRoots: readonly string[],
  filePath: string
): string {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("Edit requires non-empty 'file_path'");
  }

  return resolvePathFromInput(workspaceRoot, allowedRoots, normalized);
}
