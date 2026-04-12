import type { PromptBuildOptions, PromptRuntimeContext, PromptSection } from "./types.js";

// 解析提示词段落，并对会话级段落做缓存，减少重复拼装成本。
export class PromptSectionResolver {
  // 会话级缓存：同一会话内复用稳定段落，避免重复计算。
  private readonly sessionCache = new Map<string, string | null>();

  async resolve(
    sections: PromptSection[],
    runtimeContext: PromptRuntimeContext,
    options: PromptBuildOptions
  ): Promise<(string | null)[]> {
    return Promise.all(
      sections.map(async (section) => {
        // 命中 session 缓存时直接返回，保持段落顺序不变。
        if (section.cacheScope === "session" && this.sessionCache.has(section.name)) {
          return this.sessionCache.get(section.name) ?? null;
        }

        const value = await section.build(runtimeContext, options);

        if (section.cacheScope === "session") {
          this.sessionCache.set(section.name, value);
        }

        return value;
      })
    );
  }

  // 在 /clear 等场景显式清空缓存，强制重新生成会话级段落。
  clearSessionCache() {
    this.sessionCache.clear();
  }
}
