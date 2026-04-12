import type { JsonRecord, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../internal/pathSandbox.js";
import { runShellCommand } from "../internal/shell.js";
import { asString, truncate } from "../internal/values.js";

// run_command 工具：在沙箱工作区内执行命令，并受审批与超时约束。
export async function runCommand(args: JsonRecord, context: ToolExecutionContext) {
  const command = asString(args.command);
  if (!command) {
    throw new Error("run_command requires 'command'");
  }

  const cwd = resolveWorkspacePath(context.workspaceRoot, asString(args.cwd) ?? ".");
  const displayCwd = toWorkspaceRelative(context.workspaceRoot, cwd);

  const approved = await context.requestApproval(`run command in ${displayCwd}: ${command}`);
  if (!approved) {
    return { denied: true, reason: "User rejected run_command" };
  }

  // 返回前截断输出，避免超长日志淹没上下文。
  const result = await runShellCommand(command, cwd, context.commandTimeoutMs);
  return {
    cwd: displayCwd,
    ...result,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr)
  };
}
