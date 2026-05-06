// 兼容层导出：集中暴露工具上下文类型、工具注册表与调度入口。
export type {
  JsonRecord,
  SubagentRunInput,
  SubagentRunResult,
  SubagentDefinitionInfo,
  SubagentProgressEvent,
  SubagentTaskInfo,
  SubagentTaskLaunchResult,
  SubagentTaskStopResult,
  SubagentTaskStatus,
  ToolPermissionPolicy,
  ToolApprovalScope,
  ToolApprovalRequest,
  ToolExecutionContext,
  ToolPermissionKind
} from "./tools/types.js";
export { TOOL_SCHEMAS } from "./tools/registry.js";
export {
  getToolSchemasByName,
  REGISTERED_TOOLS,
  getToolDefinition,
  type AgentTool
} from "./tools/definitions.js";
export { executeToolCall } from "./tools/executeToolCall.js";
