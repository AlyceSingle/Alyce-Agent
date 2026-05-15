import { z } from "zod";
import type { PtySessionInfo } from "../../core/pty/ptyTypes.js";
import type { ToolExecutionContext } from "../types.js";
import { PTY_LIST_TOOL_DESCRIPTION, PTY_LIST_TOOL_NAME } from "./prompt.js";

export const PtyListInputSchema = z.object({}).strict();

export interface PtyListResult {
  sessions: PtySessionSummary[];
}

export interface PtySessionSummary {
  pty_id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: PtySessionInfo["status"];
  pid: number | null;
  cols: number;
  rows: number;
  created_at: string;
  updated_at: string;
  exited_at?: string;
  exit_code?: number;
  signal?: number;
  last_error?: string;
}

export { PTY_LIST_TOOL_DESCRIPTION, PTY_LIST_TOOL_NAME };

export async function executePtyListTool(
  _input: z.infer<typeof PtyListInputSchema>,
  context: ToolExecutionContext
): Promise<PtyListResult> {
  if (!context.ptyManager) {
    throw new Error("PtyList is not available in this execution context.");
  }

  return {
    sessions: context.ptyManager.listSessions().map(toPtySessionSummary)
  };
}

export function toPtySessionSummary(info: PtySessionInfo): PtySessionSummary {
  return {
    pty_id: info.id,
    title: info.title,
    command: info.command,
    args: [...info.args],
    cwd: info.cwd,
    status: info.status,
    pid: info.pid,
    cols: info.cols,
    rows: info.rows,
    created_at: info.createdAt,
    updated_at: info.updatedAt,
    ...(info.exitedAt ? { exited_at: info.exitedAt } : {}),
    ...(info.exitCode !== undefined ? { exit_code: info.exitCode } : {}),
    ...(info.signal !== undefined ? { signal: info.signal } : {}),
    ...(info.lastError ? { last_error: info.lastError } : {})
  };
}
