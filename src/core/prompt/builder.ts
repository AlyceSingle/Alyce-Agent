import { DYNAMIC_PROMPT_SECTIONS, STATIC_PROMPT_SECTIONS, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./sections.js";
import { PromptSectionResolver } from "./sectionResolver.js";
import type { PromptBuildOptions, PromptRuntimeContext } from "./types.js";

const ADDITIONAL_INSTRUCTIONS_TITLE = "# Additional Instructions";

// 过滤空段落，避免最终提示词出现多余空块。
function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// 构建默认 system prompt：静态段 + 边界标记 + 动态段。
export async function buildDefaultSystemPrompt(
  runtimeContext: PromptRuntimeContext,
  options: PromptBuildOptions,
  resolver: PromptSectionResolver
): Promise<string> {
  // 静态段和动态段可并行解析，降低单轮等待时间。
  const [staticParts, dynamicParts] = await Promise.all([
    resolver.resolve(STATIC_PROMPT_SECTIONS, runtimeContext, options),
    resolver.resolve(DYNAMIC_PROMPT_SECTIONS, runtimeContext, options)
  ]);

  const sections = [
    ...staticParts.filter(nonEmpty),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ...dynamicParts.filter(nonEmpty)
  ];

  return sections.join("\n\n");
}

// 支持默认提示词和追加指令两种模式，便于后续实验与扩展。
export async function buildEffectiveSystemPrompt(
  runtimeContext: PromptRuntimeContext,
  options: PromptBuildOptions,
  resolver: PromptSectionResolver
): Promise<string> {
  const appendPart = options.appendSystemPrompt?.trim();
  const primaryPrompt = await buildDefaultSystemPrompt(runtimeContext, options, resolver);

  if (!appendPart) {
    return primaryPrompt;
  }

  return [primaryPrompt, ADDITIONAL_INSTRUCTIONS_TITLE, appendPart].join("\n\n");
}
