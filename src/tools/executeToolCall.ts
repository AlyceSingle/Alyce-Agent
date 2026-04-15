import { ZodError } from "zod";
import { isTurnInterruptedError, throwIfAborted, toTurnInterruptedError } from "../core/abort.js";
import { getToolDefinition } from "./definitions.js";
import type { JsonRecord, ToolExecutionContext } from "./types.js";

// 统一处理“查找工具 -> 解析参数 -> 校验 schema -> 执行 -> 包装结果”这条路径。
export async function executeToolCall(
  name: string,
  rawArgs: string,
  context: ToolExecutionContext
): Promise<string> {
  throwIfAborted(context.abortSignal);

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
    // 模型产出的 arguments 始终先按 JSON 解析，再交给 zod 做结构校验。
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
    // 参数错误返回结构化结果，模型还能根据 issues 修正下一次工具调用。
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
    throwIfAborted(context.abortSignal);
    const result = await tool.execute(parsed.data, context);
    throwIfAborted(context.abortSignal);
    // 统一返回稳定的 JSON 包装，便于模型继续消费工具结果。
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
    // 中断不能在这里被吞成普通工具失败，否则上层无法触发恢复逻辑。
    if (isTurnInterruptedError(error, context.abortSignal)) {
      throw toTurnInterruptedError(error, context.abortSignal);
    }

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
