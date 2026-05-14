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
    return context.workspaceRoot;
  }

  const resolved = await resolveWritablePathWithExternalApproval(context, normalized, {
    toolName: options.toolName,
    title: options.title,
    kind: "directory"
  });
  return resolved.absolutePath;
}
