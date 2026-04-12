import { REGISTERED_TOOLS, TOOL_SCHEMAS } from "./definitions.js";

export { REGISTERED_TOOLS, TOOL_SCHEMAS };

// 仅暴露工具名列表，用于提示词动态段展示可用能力。
export function getRegisteredToolNames() {
  return REGISTERED_TOOLS.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
}
