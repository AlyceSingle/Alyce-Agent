import { DYNAMIC_PROMPT_SECTIONS, STATIC_PROMPT_SECTIONS, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./sections.js";
import { PromptSectionResolver } from "./sectionResolver.js";
import type { PromptBuildOptions, PromptRuntimeContext } from "./types.js";

const ADDITIONAL_INSTRUCTIONS_TITLE = "# Additional Instructions";

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function buildDefaultSystemPrompt(
  runtimeContext: PromptRuntimeContext,
  options: PromptBuildOptions,
  resolver: PromptSectionResolver
): Promise<string> {
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

// 支持默认提示词、整段覆盖和追加指令三种模式，便于后续实验与扩展。
export async function buildEffectiveSystemPrompt(
  runtimeContext: PromptRuntimeContext,
  options: PromptBuildOptions,
  resolver: PromptSectionResolver
): Promise<string> {
  const appendPart = options.appendSystemPrompt?.trim();

  const primaryPrompt = options.customSystemPrompt?.trim()
    ? options.customSystemPrompt.trim()
    : await buildDefaultSystemPrompt(runtimeContext, options, resolver);

  if (!appendPart) {
    return primaryPrompt;
  }

  return [primaryPrompt, ADDITIONAL_INSTRUCTIONS_TITLE, appendPart].join("\n\n");
}
