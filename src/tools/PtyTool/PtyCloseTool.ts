import { z } from "zod";
import type { PtyCloseResult as CorePtyCloseResult } from "../../core/pty/ptyTypes.js";
import type { ToolExecutionContext } from "../types.js";
import { PTY_CLOSE_TOOL_DESCRIPTION, PTY_CLOSE_TOOL_NAME } from "./prompt.js";
import { toPtySessionSummary, type PtySessionSummary } from "./PtyListTool.js";

export const PtyCloseInputSchema = z
  .object({
    pty_id: z.string().trim().min(1).describe("The pty_id returned by PtyCreate or PtyList.")
  })
  .strict();

export interface PtyCloseResult {
  pty_id: string;
  status: CorePtyCloseResult["status"];
  message: string;
  session?: PtySessionSummary;
}

export { PTY_CLOSE_TOOL_DESCRIPTION, PTY_CLOSE_TOOL_NAME };

export async function executePtyCloseTool(
  input: z.infer<typeof PtyCloseInputSchema>,
  context: ToolExecutionContext
): Promise<PtyCloseResult> {
  if (!context.ptyManager) {
    throw new Error("PtyClose is not available in this execution context.");
  }

  if (context.planMode) {
    throw new Error("PtyClose is blocked by Plan Mode. Exit Plan Mode before closing interactive PTY sessions.");
  }

  const session = context.ptyManager.getSession(input.pty_id);
  const approved = await context.requestApproval({
    kind: "command",
    toolName: PTY_CLOSE_TOOL_NAME,
    title: "Close interactive PTY session",
    summary: input.pty_id,
    details: [
      `PTY id: ${input.pty_id}`,
      ...(session
        ? [
            `Title: ${session.title}`,
            `Status: ${session.status}`,
            `PID: ${session.pid ?? "(unknown)"}`,
            `Working directory: ${session.cwd}`,
            `Command: ${[session.command, ...session.args].join(" ")}`
          ]
        : ["PTY session is not currently known."])
    ],
    permission: {
      permission: "shell",
      pattern: `PtyClose ${input.pty_id}`
    },
    forceAsk: false
  });

  if (!approved) {
    throw new Error("User rejected PtyClose tool request");
  }

  const result = context.ptyManager.closeSession(input.pty_id);
  if (result.status !== "not_found") {
    context.recordToolActivity?.(PTY_CLOSE_TOOL_NAME);
  }

  return {
    pty_id: result.ptyId,
    status: result.status,
    message: result.message,
    ...(result.info ? { session: toPtySessionSummary(result.info) } : {})
  };
}
