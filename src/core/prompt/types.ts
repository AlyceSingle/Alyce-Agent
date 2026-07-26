import type { MemoryPromptContext } from "../memory/types.js";
import type { SkillPromptContext } from "../../skills/service.js";
import type { GitStatusPromptContext } from "../startup/gitStatusContext.js";

// 提示词运行时上下文：由当前会话状态与环境信息组成。
export interface PromptRuntimeContext {
  model: string;
  workspaceRoot: string;
  allowedRoots: string[];
  currentDate: string;
  currentDateTime: string;
  timeZone: string;
  platform: string;
  availableTools: string[];
  availableSkills?: SkillPromptContext;
  memory?: MemoryPromptContext;
  /** 会话启动时的 git 快照；非 git 仓库或采集失败时缺省。 */
  gitStatus?: GitStatusPromptContext;
}

// 提示词构建可选覆盖项：语言偏好、自定义行为覆盖、整段覆盖、追加指令。
export interface PromptBuildOptions {
  languagePreference?: string;
  personaPreset?: string;
  aiPersonalityPrompt?: string;
  appendSystemPrompt?: string;
}

export type PromptCacheScope = "session" | "turn";

// 单个提示词段落构建函数：允许按运行时上下文和覆盖选项生成文本。
export type PromptSectionBuilder = (
  runtimeContext: PromptRuntimeContext,
  options: PromptBuildOptions
) => string | null | Promise<string | null>;

// 单个提示词段落定义：声明名称、缓存范围与构建函数。
export interface PromptSection {
  name: string;
  cacheScope: PromptCacheScope;
  build: PromptSectionBuilder;
}
