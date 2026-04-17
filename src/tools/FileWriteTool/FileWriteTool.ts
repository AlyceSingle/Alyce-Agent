import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolvePathFromInput, toWorkspaceRelative } from "../internal/pathSandbox.js";
import type { ToolExecutionContext } from "../types.js";
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from "./prompt.js";

export const FileWriteInputSchema = z
  .object({
    file_path: z
      .string()
      .describe("Absolute path or workspace-relative path to the file inside allowed directories"),
    content: z.string().describe("Full file content to write")
  })
  .strict();

export interface FileWriteResult {
  type: "create" | "update";
  filePath: string;
  bytes: number;
  lineCount: number;
}

export const FILE_WRITE_TOOL_DESCRIPTION = getWriteToolDescription();

export async function executeFileWrite(
  input: z.infer<typeof FileWriteInputSchema>,
  context: ToolExecutionContext
): Promise<FileWriteResult> {
  // 路径解析统一走工作区沙箱，避免写入越界。
  const fullFilePath = resolveWritePath(context.workspaceRoot, context.allowedRoots, input.file_path);
  const relativePath = toWorkspaceRelative(context.workspaceRoot, fullFilePath);

  const exists = await fileExists(fullFilePath);
  const mode: FileWriteResult["type"] = exists ? "update" : "create";
  const byteSize = Buffer.byteLength(input.content, "utf8");

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

  // 写入前确保父目录存在，兼容创建新文件场景。
  await context.captureFileBeforeWrite(fullFilePath);
  await fs.mkdir(path.dirname(fullFilePath), { recursive: true });
  await fs.writeFile(fullFilePath, input.content, "utf8");

  return {
    type: mode,
    filePath: relativePath,
    bytes: byteSize,
    lineCount: input.content.length === 0 ? 0 : input.content.split(/\r?\n/).length
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
