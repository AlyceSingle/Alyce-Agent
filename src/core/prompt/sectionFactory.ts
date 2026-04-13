import type { PromptCacheScope, PromptSection, PromptSectionBuilder } from "./types.js";

// 统一生成提示词段落，避免在 sections.ts 中重复书写样板对象。
export function createPromptSection(
  name: string,
  cacheScope: PromptCacheScope,
  build: PromptSectionBuilder
): PromptSection {
  return {
    name,
    cacheScope,
    build
  };
}

export function sessionPromptSection(
  name: string,
  build: PromptSectionBuilder
): PromptSection {
  return createPromptSection(name, "session", build);
}

export function turnPromptSection(
  name: string,
  build: PromptSectionBuilder
): PromptSection {
  return createPromptSection(name, "turn", build);
}
