import { promises as fs } from "node:fs";
import type { ToolExecutionContext } from "../types.js";
import { resolveWritablePathWithExternalApproval } from "./externalDirectoryAccess.js";

export async function resolveCommandWorkingDirectory(
  context: ToolExecutionContext,
  cwd: string | undefined,
  options: {
    toolName: string;
    title: string;
  }
): Promise<string> {
  const normalized = cwd?.trim();
  if (!normalized) {
    await assertExistingDirectory(context.workspaceRoot);
    return context.workspaceRoot;
  }

  const resolved = await resolveWritablePathWithExternalApproval(context, normalized, {
    toolName: options.toolName,
    title: options.title,
    kind: "directory"
  });
  await assertExistingDirectory(resolved.absolutePath);
  return resolved.absolutePath;
}

async function assertExistingDirectory(absolutePath: string): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`Working directory does not exist: ${absolutePath}`);
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${absolutePath}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
