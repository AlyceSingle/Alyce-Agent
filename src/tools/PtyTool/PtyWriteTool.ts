import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";
import { PTY_WRITE_TOOL_DESCRIPTION, PTY_WRITE_TOOL_NAME } from "./prompt.js";
import { toPtySessionSummary, type PtySessionSummary } from "./PtyListTool.js";

export const PtyWriteInputSchema = z
  .object({
    pty_id: z.string().trim().min(1).describe("The pty_id returned by PtyCreate or PtyList."),
    data: z.string().min(1).describe("Input to write to the PTY, such as shell text followed by \\n.")
  })
  .strict();

export interface PtyWriteResult {
  pty_id: string;
  bytes: number;
  cursor: number;
  session: PtySessionSummary;
}

export { PTY_WRITE_TOOL_DESCRIPTION, PTY_WRITE_TOOL_NAME };

export async function executePtyWriteTool(
  input: z.infer<typeof PtyWriteInputSchema>,
  context: ToolExecutionContext
): Promise<PtyWriteResult> {
  if (!context.ptyManager) {
    throw new Error("PtyWrite is not available in this execution context.");
  }

  if (context.planMode) {
    throw new Error("PtyWrite is blocked by Plan Mode. Exit Plan Mode before writing to interactive PTY sessions.");
  }

  const session = context.ptyManager.getSession(input.pty_id);
  const approved = await context.requestApproval({
    kind: "command",
    toolName: PTY_WRITE_TOOL_NAME,
    title: "Write to interactive PTY session",
    summary: previewInput(input.data),
    details: [
      `PTY id: ${input.pty_id}`,
      ...(session
        ? [
            `Title: ${session.title}`,
            `Status: ${session.status}`,
            `Working directory: ${session.cwd}`,
            `Command: ${[session.command, ...session.args].join(" ")}`
          ]
        : ["PTY session is not currently known."]),
      "Input:",
      input.data
    ],
    permission: {
      permission: "shell",
      pattern: `PtyWrite ${input.pty_id} ${input.data}`
    },
    forceAsk: true
  });

  if (!approved) {
    throw new Error("User rejected PtyWrite tool request");
  }

  const result = context.ptyManager.writeSession(input.pty_id, input.data);
  context.recordToolActivity?.(PTY_WRITE_TOOL_NAME);
  return {
    pty_id: result.ptyId,
    bytes: result.bytes,
    cursor: result.cursor,
    session: toPtySessionSummary(result.info)
  };
}

function previewInput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const maxChars = 120;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}
