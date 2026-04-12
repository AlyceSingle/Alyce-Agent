export interface PromptRuntimeContext {
  model: string;
  workspaceRoot: string;
  currentDate: string;
  platform: string;
  availableTools: string[];
}

export interface PromptBuildOptions {
  languagePreference?: string;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
}

export interface PromptSection {
  name: string;
  cacheScope: "session" | "turn";
  build: (
    runtimeContext: PromptRuntimeContext,
    options: PromptBuildOptions
  ) => string | null | Promise<string | null>;
}
