import type OpenAI from "openai";
import { ZodError } from "zod";
import { isTurnInterruptedError, throwIfAborted, toTurnInterruptedError } from "../core/abort.js";
import { getPlanModeToolViolation } from "../core/planMode/planMode.js";
import { getToolDefinition } from "./definitions.js";
import { isToolResultEnvelope } from "./resultEnvelope.js";
import { getToolPolicyViolation } from "./toolPolicy.js";
import type { JsonRecord, ToolExecutionContext } from "./types.js";
import { getErrorMessage } from "../core/util/error.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ExecutedToolCall {
  displayResult: string;
  supplementalMessages: MessageParam[];
}

export type ToolExecutionStatus =
  | "success"
  | "rejected"
  | "denied"
  | "failed"
  | "timeout"
  | "aborted";

interface ToolFailurePayload {
  status: Exclude<ToolExecutionStatus, "success">;
  type: string;
  message: string;
  issues?: ReturnType<typeof formatZodIssues>;
  result?: unknown;
}

// 统一处理“查找工具 -> 解析参数 -> 校验 schema -> 执行 -> 包装结果”这条路径。
export async function executeToolCall(
  name: string,
  rawArgs: string,
  context: ToolExecutionContext
): Promise<ExecutedToolCall> {
  throwIfAborted(context.abortSignal);

  const tool = getToolDefinition(name);
  if (context.planMode) {
    const planModeViolation = getPlanModeToolViolation(name);
    if (planModeViolation) {
      return createFailedToolCallResult({
        status: "denied",
        type: "plan_mode_violation",
        message: planModeViolation
      });
    }
  }

  if (!tool) {
    if (context.mcpRuntime?.canExecuteTool(name)) {
      return executeMcpToolCall(name, rawArgs, context);
    }

    return createFailedToolCallResult({
      status: "failed",
      type: "unknown_tool",
      message: `Unknown tool: ${name}`
    });
  }

  let args: JsonRecord = {};

  try {
    // 模型产出的 arguments 始终先按 JSON 解析，再交给 zod 做结构校验。
    args = rawArgs ? (JSON.parse(rawArgs) as JsonRecord) : {};
  } catch {
    return createFailedToolCallResult({
      status: "failed",
      type: "invalid_json_arguments",
      message: "Invalid JSON arguments"
    });
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    // 参数错误返回结构化结果，模型还能根据 issues 修正下一次工具调用。
    return createFailedToolCallResult({
      status: "failed",
      type: "invalid_tool_arguments",
      message: `Input validation failed for tool '${name}'.`,
      issues: formatZodIssues(parsed.error)
    });
  }

  const policyError = getToolPolicyViolation(name, parsed.data as JsonRecord, context.toolPolicy);
  if (policyError) {
    return createFailedToolCallResult({
      status: "denied",
      type: "tool_policy_violation",
      message: policyError
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
    const structuredFailure = classifyStructuredToolResult(name, result);
    if (structuredFailure) {
      return createFailedToolCallResult(
        structuredFailure,
        supplementalMessages
      );
    }

    // 统一返回稳定的 JSON 包装，便于模型继续消费工具结果。
    return createSuccessfulToolCallResult(name, result, supplementalMessages);
  } catch (error) {
    // 中断不能在这里被吞成普通工具失败，否则上层无法触发恢复逻辑。
    if (isTurnInterruptedError(error, context.abortSignal)) {
      throw toTurnInterruptedError(error, context.abortSignal);
    }

    return createFailedToolCallResult(classifyToolExecutionError(error, "tool_execution_error"));
  }
}

async function executeMcpToolCall(
  name: string,
  rawArgs: string,
  context: ToolExecutionContext
): Promise<ExecutedToolCall> {
  let args: JsonRecord = {};

  try {
    args = rawArgs ? (JSON.parse(rawArgs) as JsonRecord) : {};
  } catch {
    return createFailedToolCallResult({
      status: "failed",
      type: "invalid_json_arguments",
      message: "Invalid JSON arguments"
    });
  }

  if (!isJsonRecord(args)) {
    return createFailedToolCallResult({
      status: "failed",
      type: "invalid_tool_arguments",
      message: `Input validation failed for MCP tool '${name}': arguments must be a JSON object.`
    });
  }

  try {
    throwIfAborted(context.abortSignal);
    const result = await context.mcpRuntime!.executeToolCall(name, args, {
      requestApproval: context.requestApproval,
      abortSignal: context.abortSignal,
      timeoutMs: context.commandTimeoutMs
    });
    throwIfAborted(context.abortSignal);
    const structuredFailure = classifyStructuredToolResult(name, result);
    if (structuredFailure) {
      return createFailedToolCallResult(structuredFailure);
    }

    context.recordToolActivity?.(name);
    return createSuccessfulToolCallResult(name, result);
  } catch (error) {
    if (isTurnInterruptedError(error, context.abortSignal)) {
      throw toTurnInterruptedError(error, context.abortSignal);
    }

    return createFailedToolCallResult(classifyToolExecutionError(error, "mcp_tool_execution_error"));
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value)
  );
}

function formatZodIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    code: issue.code,
    message: issue.message
  }));
}

function classifyStructuredToolResult(
  toolName: string,
  result: unknown
): ToolFailurePayload | null {
  const record = isJsonRecord(result) ? result : null;
  if (!record) {
    return null;
  }

  const status = typeof record.status === "string" ? record.status : undefined;
  const message = getStructuredResultMessage(record);
  const nestedRejectionMessage = getNestedRejectedMessage(record);

  if (status === "rejected" || isUserRejectedMessage(message) || nestedRejectionMessage) {
    return {
      status: "rejected",
      type: "permission_rejected",
      message: message || nestedRejectionMessage || `${toolName} request was rejected by the user.`,
      result
    };
  }

  if (record.timedOut === true) {
    return {
      status: "timeout",
      type: "tool_timeout",
      message: `${toolName} timed out before completing.`,
      result
    };
  }

  if (status === "error") {
    const errorCode = typeof record.error === "string" ? record.error : undefined;
    return {
      status: "failed",
      type: errorCode === "mcp_server_unavailable"
        ? "mcp_unavailable"
        : errorCode ?? "tool_result_error",
      message: message || `${toolName} returned an error result.`,
      result
    };
  }

  return null;
}

function classifyToolExecutionError(error: unknown, fallbackType: string): ToolFailurePayload {
  const message = getErrorMessage(error);
  if (isUserRejectedMessage(message)) {
    return {
      status: "rejected",
      type: "permission_rejected",
      message
    };
  }

  if (/blocked by Plan Mode/i.test(message)) {
    return {
      status: "denied",
      type: "plan_mode_violation",
      message
    };
  }

  if (/blocked by safety policy|policy violation|not allowed|denied/i.test(message)) {
    return {
      status: "denied",
      type: "policy_denied",
      message
    };
  }

  if (/timed?\s*out|timeout/i.test(message)) {
    return {
      status: "timeout",
      type: fallbackType === "mcp_tool_execution_error"
        ? "mcp_tool_timeout"
        : "tool_timeout",
      message
    };
  }

  if (/MCP runtime is not available|MCP server is unavailable|mcp_server_unavailable/i.test(message)) {
    return {
      status: "failed",
      type: "mcp_unavailable",
      message
    };
  }

  return {
    status: "failed",
    type: fallbackType,
    message
  };
}

function getStructuredResultMessage(record: JsonRecord): string | undefined {
  for (const key of ["message", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function getNestedRejectedMessage(record: JsonRecord): string | undefined {
  if (!Array.isArray(record.servers)) {
    return undefined;
  }

  for (const item of record.servers) {
    if (!isJsonRecord(item)) {
      continue;
    }

    const message = getStructuredResultMessage(item);
    if (isUserRejectedMessage(message)) {
      return message;
    }
  }

  return undefined;
}

function isUserRejectedMessage(message: string | undefined): boolean {
  return Boolean(message && /user rejected|permission request rejected|approval rejected/i.test(message));
}

function createSuccessfulToolCallResult(
  toolName: string,
  result: unknown,
  supplementalMessages: ExecutedToolCall["supplementalMessages"] = []
): ExecutedToolCall {
  return createExecutedToolCallResult(
    {
      ok: true,
      status: "success",
      tool: toolName,
      result
    },
    supplementalMessages
  );
}

function createFailedToolCallResult(
  failure: ToolFailurePayload,
  supplementalMessages: ExecutedToolCall["supplementalMessages"] = []
): ExecutedToolCall {
  return createExecutedToolCallResult(
    {
      ok: false,
      status: failure.status,
      ...(failure.result !== undefined ? { result: failure.result } : {}),
      error: {
        type: failure.type,
        status: failure.status,
        message: failure.message,
        ...(failure.issues ? { issues: failure.issues } : {})
      }
    },
    supplementalMessages
  );
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
