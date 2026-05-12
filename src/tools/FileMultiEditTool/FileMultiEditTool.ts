import type { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { withFileWriteLock } from "../internal/fileWriteLocks.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import { resolveWritablePathWithExternalApproval } from "../internal/externalDirectoryAccess.js";
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
import { getPatchForEdit, resolveEditMatch } from "../FileEditTool/utils.js";
import {
  FILE_MULTI_EDIT_TOOL_NAME,
  getMultiEditToolDescription
} from "./prompt.js";
import { FileMultiEditInputSchema, type FileMultiEditOutput } from "./types.js";

export const FILE_MULTI_EDIT_TOOL_DESCRIPTION = getMultiEditToolDescription();

export async function executeFileMultiEdit(
  input: z.infer<typeof FileMultiEditInputSchema>,
  context: ToolExecutionContext
): Promise<FileMultiEditOutput> {
  const resolvedPath = await resolveMultiEditPath(context, input.file_path);
  const fullFilePath = resolvedPath.absolutePath;
  const relativePath = toWorkspaceRelative(context.workspaceRoot, fullFilePath);

  return withFileWriteLock(fullFilePath, () =>
    executeFileMultiEditLocked(input, context, fullFilePath, relativePath, resolvedPath.allowedRoots)
  );
}

async function executeFileMultiEditLocked(
  input: z.infer<typeof FileMultiEditInputSchema>,
  context: ToolExecutionContext,
  fullFilePath: string,
  relativePath: string,
  allowedRoots: readonly string[]
): Promise<FileMultiEditOutput> {
  await ensureFreshFileRead(fullFilePath, context, FILE_MULTI_EDIT_TOOL_NAME);

  const originalMetadata = await readTextFileBytesWithMetadata(fullFilePath);
  const originalFile = originalMetadata.content;
  let updatedFile = originalFile;
  let totalMatches = 0;
  const appliedEdits: FileMultiEditOutput["edits"] = [];

  input.edits.forEach((edit, index) => {
    if (edit.old_string === edit.new_string) {
      throw new Error(`Edit ${index + 1} has identical old_string and new_string`);
    }

    const match = resolveEditMatch(updatedFile, edit.old_string, Boolean(edit.replace_all));
    const patchResult = getPatchForEdit({
      filePath: relativePath,
      fileContents: updatedFile,
      oldString: match.actualOldString,
      newString: edit.new_string,
      replaceAll: edit.replace_all
    });
    updatedFile = patchResult.updatedFile;
    totalMatches += match.matchCount;
    appliedEdits.push({
      oldString: edit.old_string,
      newString: edit.new_string,
      actualOldString: match.actualOldString,
      replaceAll: Boolean(edit.replace_all),
      matchCount: match.matchCount,
      matchStrategy: match.strategy
    });
  });

  if (updatedFile === originalFile) {
    throw new Error("MultiEdit produced no changes");
  }

  const approved = await context.requestApproval({
    kind: "file-write",
    toolName: FILE_MULTI_EDIT_TOOL_NAME,
    title: "Edit file multiple times",
    summary: relativePath,
    details: [
      `Edits: ${input.edits.length}`,
      `Total matches: ${totalMatches}`,
      `Strategies: ${[...new Set(appliedEdits.map((edit) => edit.matchStrategy))].join(", ")}`
    ]
  });
  if (!approved) {
    throw new Error("User rejected MultiEdit tool request");
  }

  throwIfAborted(context.abortSignal);

  await assertExistingFileBytesUnchangedAfterApproval(fullFilePath, originalMetadata.rawBytes, {
    toolName: FILE_MULTI_EDIT_TOOL_NAME,
    deletedRetryAction: "editing it",
    changedRetryAction: "modifying it"
  });

  await context.captureFileBeforeWrite(fullFilePath);
  await writeTextFileWithMetadata(fullFilePath, updatedFile, {
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
    editCount: input.edits.length,
    edits: appliedEdits,
    structuredPatch: getPatchForEdit({
      filePath: relativePath,
      fileContents: originalFile,
      oldString: originalFile,
      newString: finalFile,
      replaceAll: false
    }).patch,
    userModified: false,
    replaceAll: input.edits.some((edit) => Boolean(edit.replace_all)),
    matchCount: totalMatches,
    formatter: postWriteChecks.formatter,
    diagnostics: postWriteChecks.diagnostics
  };
}

async function resolveMultiEditPath(
  context: ToolExecutionContext,
  filePath: string
): Promise<{
  absolutePath: string;
  allowedRoots: string[];
}> {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("MultiEdit requires non-empty 'file_path'");
  }

  return resolveWritablePathWithExternalApproval(context, normalized, {
    toolName: FILE_MULTI_EDIT_TOOL_NAME,
    title: "MultiEdit external path",
    kind: "file"
  });
}
