import { promises as fs } from "node:fs";
import type { z } from "zod";
import { resolvePathFromInput, toWorkspaceRelative } from "../internal/pathSandbox.js";
import type { ToolExecutionContext } from "../types.js";
import { FILE_EDIT_TOOL_NAME } from "./constants.js";
import { getEditToolDescription } from "./prompt.js";
import { type FileEditOutput, inputSchema } from "./types.js";
import { findActualString, getPatchForEdit, preserveQuoteStyle } from "./utils.js";

export const FileEditInputSchema = inputSchema();
export const FILE_EDIT_TOOL_DESCRIPTION = getEditToolDescription();

export async function executeFileEdit(
  input: z.infer<typeof FileEditInputSchema>,
  context: ToolExecutionContext
): Promise<FileEditOutput> {
  // 统一先解析为工作区内绝对路径，后续读写都基于同一路径。
  const fullFilePath = resolveEditPath(context.workspaceRoot, context.allowedRoots, input.file_path);
  const relativePath = toWorkspaceRelative(context.workspaceRoot, fullFilePath);

  const originalFile = await fs.readFile(fullFilePath, "utf8");
  if (input.old_string === input.new_string) {
    throw new Error("No changes to make: old_string and new_string are identical");
  }

  const actualOldString = findActualString(originalFile, input.old_string);
  if (!actualOldString) {
    throw new Error("String to replace was not found in the target file");
  }

  // 默认要求 old_string 唯一命中，避免误改多处内容。
  const matchCount = countMatches(originalFile, actualOldString);
  if (matchCount > 1 && !input.replace_all) {
    throw new Error(
      `Found ${matchCount} matches. Set replace_all=true or provide more unique old_string context.`
    );
  }

  const adjustedNewString = preserveQuoteStyle(input.old_string, actualOldString, input.new_string);
  const patchResult = getPatchForEdit({
    filePath: relativePath,
    fileContents: originalFile,
    oldString: actualOldString,
    newString: adjustedNewString,
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
    details: [`Matches: ${matchCount}`, `Replace all: ${input.replace_all ? "yes" : "no"}`]
  });
  if (!approved) {
    throw new Error("User rejected Edit tool request");
  }

  await context.captureFileBeforeWrite(fullFilePath);
  await fs.writeFile(fullFilePath, patchResult.updatedFile, "utf8");

  return {
    filePath: relativePath,
    oldString: input.old_string,
    newString: adjustedNewString,
    originalFile,
    structuredPatch: patchResult.patch,
    userModified: false,
    replaceAll: Boolean(input.replace_all),
    matchCount
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

function countMatches(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  return content.split(needle).length - 1;
}
