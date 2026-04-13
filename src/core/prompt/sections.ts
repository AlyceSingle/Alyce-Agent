import { DYNAMIC_PROMPT_SECTIONS } from "./fragments/dynamicSections.js";
import { STATIC_PROMPT_SECTIONS } from "./fragments/staticSections.js";

// 静态段与动态段之间的边界标记，便于调试与缓存分层。
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export { STATIC_PROMPT_SECTIONS, DYNAMIC_PROMPT_SECTIONS };
