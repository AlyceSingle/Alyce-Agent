import type { PromptBuildOptions, PromptRuntimeContext, PromptSection } from "./types.js";

// 解析提示词段落，并对会话级段落做缓存，减少重复拼装成本。
export class PromptSectionResolver {
  private readonly sessionCache = new Map<string, string | null>();

  async resolve(
    sections: PromptSection[],
    runtimeContext: PromptRuntimeContext,
    options: PromptBuildOptions
  ): Promise<(string | null)[]> {
    return Promise.all(
      sections.map(async (section) => {
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

  clearSessionCache() {
    this.sessionCache.clear();
  }
}
