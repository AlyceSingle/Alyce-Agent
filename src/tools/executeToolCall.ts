import type { JsonRecord, ToolExecutionContext } from "./types.js";
import { getToolDefinition } from "./definitions.js";
import { ZodError } from "zod";

// 工具调度入口：解析参数、分发到具体实现并统一错误返回格式。
export async function executeToolCall(
  name: string,
  rawArgs: string,
  context: ToolExecutionContext
): Promise<string> {
  const tool = getToolDefinition(name);
  if (!tool) {
    return JSON.stringify(
      {
        ok: false,
        error: {
          type: "unknown_tool",
          message: `Unknown tool: ${name}`
        }
      },
      null,
      2
    );
  }

  let args: JsonRecord = {};

  try {
    // 工具参数由模型以 JSON 字符串传入。
    args = rawArgs ? (JSON.parse(rawArgs) as JsonRecord) : {};
  } catch {
    return JSON.stringify(
      {
        ok: false,
        error: {
          type: "invalid_json_arguments",
          message: "Invalid JSON arguments"
        }
      },
      null,
      2
    );
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return JSON.stringify(
      {
        ok: false,
        error: {
          type: "invalid_tool_arguments",
          message: `Input validation failed for tool '${name}'.`,
          issues: formatZodIssues(parsed.error)
        }
      },
      null,
      2
    );
  }

  try {
    const result = await tool.execute(parsed.data, context);
    return JSON.stringify(
      {
        ok: true,
        tool: name,
        result
      },
      null,
      2
    );
  } catch (error) {
    // 工具内部异常统一序列化，避免中断整轮推理。
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(
      {
        ok: false,
        error: {
          type: "tool_execution_error",
          message
        }
      },
      null,
      2
    );
  }
}

function formatZodIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    code: issue.code,
    message: issue.message
  }));
}
