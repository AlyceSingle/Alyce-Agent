import type OpenAI from "openai";
import { ZodError } from "zod";
import { isTurnInterruptedError, throwIfAborted, toTurnInterruptedError } from "../core/abort.js";
import { getToolDefinition } from "./definitions.js";
import { isToolResultEnvelope } from "./resultEnvelope.js";
import type { JsonRecord, ToolExecutionContext } from "./types.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ExecutedToolCall {
  displayResult: string;
  supplementalMessages: MessageParam[];
}

// 统一处理“查找工具 -> 解析参数 -> 校验 schema -> 执行 -> 包装结果”这条路径。
export async function executeToolCall(
  name: string,
  rawArgs: string,
  context: ToolExecutionContext
): Promise<ExecutedToolCall> {
  throwIfAborted(context.abortSignal);

  const tool = getToolDefinition(name);
  if (!tool) {
    return createExecutedToolCallResult({
      ok: false,
      error: {
        type: "unknown_tool",
        message: `Unknown tool: ${name}`
      }
    });
  }

  let args: JsonRecord = {};

  try {
    // 模型产出的 arguments 始终先按 JSON 解析，再交给 zod 做结构校验。
    args = rawArgs ? (JSON.parse(rawArgs) as JsonRecord) : {};
  } catch {
    return createExecutedToolCallResult({
      ok: false,
      error: {
        type: "invalid_json_arguments",
        message: "Invalid JSON arguments"
      }
    });
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    // 参数错误返回结构化结果，模型还能根据 issues 修正下一次工具调用。
    return createExecutedToolCallResult({
      ok: false,
      error: {
        type: "invalid_tool_arguments",
        message: `Input validation failed for tool '${name}'.`,
        issues: formatZodIssues(parsed.error)
      }
    });
  }

  try {
    throwIfAborted(context.abortSignal);
    const rawResult = await tool.execute(parsed.data, context);
    throwIfAborted(context.abortSignal);
    const result = isToolResultEnvelope(rawResult) ? rawResult.result : rawResult;
    const supplementalMessages = isToolResultEnvelope(rawResult)
      ? (rawResult.supplementalMessages ?? [])
      : [];
    // 统一返回稳定的 JSON 包装，便于模型继续消费工具结果。
    return createExecutedToolCallResult(
      {
        ok: true,
        tool: name,
        result
      },
      supplementalMessages
    );
  } catch (error) {
    // 中断不能在这里被吞成普通工具失败，否则上层无法触发恢复逻辑。
    if (isTurnInterruptedError(error, context.abortSignal)) {
      throw toTurnInterruptedError(error, context.abortSignal);
    }

    const message = error instanceof Error ? error.message : String(error);
    return createExecutedToolCallResult({
      ok: false,
      error: {
        type: "tool_execution_error",
        message
      }
    });
  }
}

function formatZodIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    code: issue.code,
    message: issue.message
  }));
}

function createExecutedToolCallResult(
  payload: Record<string, unknown>,
  supplementalMessages: ExecutedToolCall["supplementalMessages"] = []
): ExecutedToolCall {
  return {
    displayResult: JSON.stringify(payload, null, 2),
    supplementalMessages
  };
}
