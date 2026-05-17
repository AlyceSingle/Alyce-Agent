import type { ProviderProfileMap } from "./types.js";

export const DEFAULT_PROVIDER_ID = "openai";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234/v1";

export const CONNECTABLE_PROVIDER_PRESET_IDS = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "kimi",
  "qwen",
  "siliconflow",
  "doubao",
  "local",
  "ollama",
  "lmstudio"
] as const;

export type ConnectableProviderPresetId = typeof CONNECTABLE_PROVIDER_PRESET_IDS[number];

export const BUILT_IN_PROVIDER_PROFILES: ProviderProfileMap = {
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseURL: "https://api.openai.com/v1",
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
  "github-copilot": {
    id: "github-copilot",
    label: "GitHub Copilot",
    kind: "openai-compatible",
    baseURL: "https://api.githubcopilot.com",
    defaultModel: "gpt-5.2",
    models: {
      "gpt-5.2": {
        label: "GPT-5.2",
        contextWindow: 400_000
      },
      "gpt-5.1-codex": {
        label: "GPT-5.1 Codex"
      },
      "claude-sonnet-4.5": {
        label: "Claude Sonnet 4.5"
      }
    }
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: {
      "deepseek-chat": {
        label: "DeepSeek Chat",
        contextWindow: 64_000
      },
      "deepseek-reasoner": {
        label: "DeepSeek Reasoner",
        contextWindow: 64_000
      }
    }
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    kind: "openai-compatible",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseURL: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.6",
    models: {
      "kimi-k2.6": {
        label: "Kimi K2.6",
        contextWindow: 256_000
      },
      "moonshot-v1-8k": {
        label: "Moonshot v1 8K",
        contextWindow: 8_192
      },
      "moonshot-v1-32k": {
        label: "Moonshot v1 32K",
        contextWindow: 32_768
      },
      "moonshot-v1-128k": {
        label: "Moonshot v1 128K",
        contextWindow: 131_072
      }
    }
  },
  qwen: {
    id: "qwen",
    label: "Qwen",
    kind: "openai-compatible",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    models: {
      "qwen-plus": {
        label: "Qwen Plus"
      },
      "qwen-max": {
        label: "Qwen Max"
      },
      "qwen-turbo": {
        label: "Qwen Turbo"
      }
    }
  },
  siliconflow: {
    id: "siliconflow",
    label: "SiliconFlow",
    kind: "openai-compatible",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    baseURL: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: {
      "deepseek-ai/DeepSeek-V3": {
        label: "DeepSeek V3"
      },
      "deepseek-ai/DeepSeek-R1": {
        label: "DeepSeek R1"
      },
      "Qwen/Qwen2.5-Coder-32B-Instruct": {
        label: "Qwen2.5 Coder 32B Instruct"
      }
    }
  },
  doubao: {
    id: "doubao",
    label: "Doubao",
    kind: "openai-compatible",
    apiKeyEnv: "ARK_API_KEY",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-1-6-250615",
    models: {
      "doubao-seed-1-6-250615": {
        label: "Doubao Seed 1.6",
        contextWindow: 256_000
      },
      "doubao-seed-1-6-flash-250615": {
        label: "Doubao Seed 1.6 Flash",
        contextWindow: 256_000
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
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    kind: "local",
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    defaultModel: "llama3.1",
    models: {
      "llama3.1": {
        label: "Llama 3.1"
      },
      "qwen3-coder": {
        label: "Qwen3 Coder"
      }
    }
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    kind: "local",
    baseURL: DEFAULT_LM_STUDIO_BASE_URL,
    defaultModel: "local-model",
    models: {
      "local-model": {
        label: "Loaded local model"
      },
      "openai/gpt-oss-20b": {
        label: "GPT OSS 20B"
      }
    }
  }
};

export function getBuiltInProviderProfile(providerId: string) {
  return BUILT_IN_PROVIDER_PROFILES[providerId.trim().toLowerCase()];
}

export function isConnectableProviderPreset(providerId: string): providerId is ConnectableProviderPresetId {
  const normalized = providerId.trim().toLowerCase();
  return (CONNECTABLE_PROVIDER_PRESET_IDS as readonly string[]).includes(normalized);
}
