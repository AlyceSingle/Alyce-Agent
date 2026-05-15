import type { ProviderProfileMap } from "./types.js";

export const DEFAULT_PROVIDER_ID = "openai";

export const BUILT_IN_PROVIDER_PROFILES: ProviderProfileMap = {
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    models: {
      "gpt-4.1-mini": {
        label: "GPT-4.1 Mini",
        contextWindow: 1_047_576
      },
      "gpt-5.2": {
        label: "GPT-5.2",
        contextWindow: 400_000
      }
    }
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4.6",
    models: {
      "claude-sonnet-4.6": {
        label: "Claude Sonnet 4.6",
        contextWindow: 1_000_000
      }
    }
  },
  google: {
    id: "google",
    label: "Google",
    kind: "google",
    apiKeyEnv: "GOOGLE_API_KEY",
    defaultModel: "gemini-3-flash",
    models: {
      "gemini-3-flash": {
        label: "Gemini 3 Flash",
        contextWindow: 1_048_576
      }
    }
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.2",
    models: {
      "openai/gpt-5.2": {
        label: "OpenAI GPT-5.2",
        contextWindow: 400_000
      }
    }
  },
  local: {
    id: "local",
    label: "Local",
    kind: "local",
    defaultModel: "local-model",
    models: {
      "local-model": {
        label: "Local model"
      }
    }
  }
};
