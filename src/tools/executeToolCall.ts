import { runCommand } from "./builtin/commandTool.js";
import { listFiles, readFile, writeFile } from "./builtin/fsTools.js";
import type { JsonRecord, ToolExecutionContext } from "./types.js";

// 工具调度入口：解析参数、分发到具体实现并统一错误返回格式。
export async function executeToolCall(
  name: string,
  rawArgs: string,
  context: ToolExecutionContext
): Promise<string> {
  let args: JsonRecord = {};

  try {
    // 工具参数由模型以 JSON 字符串传入。
    args = rawArgs ? (JSON.parse(rawArgs) as JsonRecord) : {};
  } catch {
    return JSON.stringify({ error: "Invalid JSON arguments" }, null, 2);
  }

  try {
    // 按工具名分发，返回统一 JSON 字符串给模型继续推理。
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
    // 工具内部异常统一序列化，避免中断整轮推理。
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message }, null, 2);
  }
}
