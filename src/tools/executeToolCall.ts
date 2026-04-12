import { runCommand } from "./builtin/commandTool.js";
import { listFiles, readFile, writeFile } from "./builtin/fsTools.js";
import type { JsonRecord, ToolExecutionContext } from "./types.js";

export async function executeToolCall(
  name: string,
  rawArgs: string,
  context: ToolExecutionContext
): Promise<string> {
  let args: JsonRecord = {};

  try {
    args = rawArgs ? (JSON.parse(rawArgs) as JsonRecord) : {};
  } catch {
    return JSON.stringify({ error: "Invalid JSON arguments" }, null, 2);
  }

  try {
    switch (name) {
      case "list_files":
        return JSON.stringify(await listFiles(args, context), null, 2);
      case "read_file":
        return JSON.stringify(await readFile(args, context), null, 2);
      case "write_file":
        return JSON.stringify(await writeFile(args, context), null, 2);
      case "run_command":
        return JSON.stringify(await runCommand(args, context), null, 2);
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message }, null, 2);
  }
}
