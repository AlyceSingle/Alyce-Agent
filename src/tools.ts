// 兼容层导出：集中暴露工具上下文类型、工具注册表与调度入口。
export type { JsonRecord, ToolExecutionContext } from "./tools/types.js";
export { TOOL_SCHEMAS } from "./tools/registry.js";
export { REGISTERED_TOOLS, getToolDefinition, type AgentTool } from "./tools/definitions.js";
export { executeToolCall } from "./tools/executeToolCall.js";
