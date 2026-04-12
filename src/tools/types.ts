// 工具执行上下文：由主程序注入工作区、超时和审批能力。
export interface ToolExecutionContext {
  workspaceRoot: string;
  requestApproval: (action: string) => Promise<boolean>;
  commandTimeoutMs: number;
}

// 通用 JSON 对象类型，用于承接模型传入的工具参数。
export type JsonRecord = Record<string, unknown>;
