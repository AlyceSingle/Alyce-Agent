export type ContextWindowSource = "override" | "model_name" | "builtin" | "fallback";

export type ModelContextWindowOverrides = Record<string, number>;

export interface ContextWindowResolution {
  contextWindow: number;
  source: ContextWindowSource;
  matchedPattern?: string;
  label: string;
}

interface ContextWindowPattern {
  pattern: string;
  contextWindow: number;
  label: string;
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const BUILTIN_CONTEXT_WINDOWS: ContextWindowPattern[] = [
  // OpenAI
  model("gpt 5.5", 1_050_000, "OpenAI GPT-5 family"),
  model("gpt 5.4", 1_050_000, "OpenAI GPT-5 family"),
  model("gpt 5.3", 1_050_000, "OpenAI GPT-5 family"),
  model("gpt 5.2", 1_050_000, "OpenAI GPT-5 family"),
  model("gpt 5.1", 1_050_000, "OpenAI GPT-5 family"),
  model("gpt 5", 1_050_000, "OpenAI GPT-5 family"),
  model("gpt 4.1", 1_047_576, "OpenAI GPT-4.1"),
  model("gpt 4.5", 128_000, "OpenAI GPT-4.5 preview"),
  model("gpt 4o", 128_000, "OpenAI GPT-4o"),
  model("chatgpt 4o", 128_000, "OpenAI ChatGPT-4o"),
  model("gpt 4 turbo", 128_000, "OpenAI GPT-4 Turbo"),
  model("gpt 4 32k", 32_768, "OpenAI GPT-4 32k"),
  model("gpt 4", 8_192, "OpenAI GPT-4"),
  model("gpt 3.5 turbo 16k", 16_385, "OpenAI GPT-3.5 Turbo 16k"),
  model("gpt 3.5 turbo", 16_385, "OpenAI GPT-3.5 Turbo"),
  model("o4 mini", 200_000, "OpenAI o4-mini"),
  model("o3", 200_000, "OpenAI o3"),
  model("o1", 200_000, "OpenAI o1"),

  // Anthropic
  model("claude opus 4.6", 1_000_000, "Anthropic Claude Opus 4.6"),
  model("claude 4.6 opus", 1_000_000, "Anthropic Claude Opus 4.6"),
  model("claude sonnet 4.6", 1_000_000, "Anthropic Claude Sonnet 4.6"),
  model("claude 4.6 sonnet", 1_000_000, "Anthropic Claude Sonnet 4.6"),
  model("claude opus 4.5", 1_000_000, "Anthropic Claude Opus 4.5"),
  model("claude 4.5 opus", 1_000_000, "Anthropic Claude Opus 4.5"),
  model("claude sonnet 4.5", 1_000_000, "Anthropic Claude Sonnet 4.5"),
  model("claude 4.5 sonnet", 1_000_000, "Anthropic Claude Sonnet 4.5"),
  model("claude haiku 4.5", 200_000, "Anthropic Claude Haiku 4.5"),
  model("claude 4.5 haiku", 200_000, "Anthropic Claude Haiku 4.5"),
  model("claude sonnet 4 context 1m", 1_000_000, "Anthropic Claude Sonnet 4 1M beta"),
  model("claude sonnet 4 1m", 1_000_000, "Anthropic Claude Sonnet 4 1M beta"),
  model("claude opus 4.1", 200_000, "Anthropic Claude Opus 4.1"),
  model("claude 4.1 opus", 200_000, "Anthropic Claude Opus 4.1"),
  model("claude opus 4", 200_000, "Anthropic Claude Opus 4"),
  model("claude 4 opus", 200_000, "Anthropic Claude Opus 4"),
  model("claude sonnet 4", 200_000, "Anthropic Claude Sonnet 4"),
  model("claude 4 sonnet", 200_000, "Anthropic Claude Sonnet 4"),
  model("claude 3.7 sonnet", 200_000, "Anthropic Claude Sonnet 3.7"),
  model("claude sonnet 3.7", 200_000, "Anthropic Claude Sonnet 3.7"),
  model("claude 3.5 sonnet", 200_000, "Anthropic Claude Sonnet 3.5"),
  model("claude sonnet 3.5", 200_000, "Anthropic Claude Sonnet 3.5"),
  model("claude 3.5 haiku", 200_000, "Anthropic Claude Haiku 3.5"),
  model("claude haiku 3.5", 200_000, "Anthropic Claude Haiku 3.5"),
  model("claude 3 opus", 200_000, "Anthropic Claude 3 Opus"),
  model("claude 3 sonnet", 200_000, "Anthropic Claude 3 Sonnet"),
  model("claude 3 haiku", 200_000, "Anthropic Claude 3 Haiku"),
  model("claude 2.1", 200_000, "Anthropic Claude 2.1"),
  model("claude 2", 100_000, "Anthropic Claude 2"),
  model("claude", 200_000, "Anthropic Claude default"),

  // Google Gemini
  model("gemini 3.1 pro", 1_048_576, "Google Gemini 3.1 Pro"),
  model("gemini 3.1 flash lite", 1_048_576, "Google Gemini 3.1 Flash-Lite"),
  model("gemini 3 pro", 1_048_576, "Google Gemini 3 Pro"),
  model("gemini 3 flash", 1_048_576, "Google Gemini 3 Flash"),
  model("gemini 2.5 pro", 1_048_576, "Google Gemini 2.5 Pro"),
  model("gemini 2.5 flash lite", 1_048_576, "Google Gemini 2.5 Flash-Lite"),
  model("gemini 2.5 flash", 1_048_576, "Google Gemini 2.5 Flash"),
  model("gemini 2.0 flash lite", 1_048_576, "Google Gemini 2.0 Flash-Lite"),
  model("gemini 2.0 flash", 1_048_576, "Google Gemini 2.0 Flash"),
  model("gemini 1.5 pro", 2_097_152, "Google Gemini 1.5 Pro"),
  model("gemini 1.5 flash", 1_048_576, "Google Gemini 1.5 Flash"),
  model("gemini pro", 32_768, "Google Gemini Pro legacy"),

  // Moonshot / Kimi
  model("moonshot kimi k2.6", 262_144, "Moonshot Kimi K2.6"),
  model("moonshot kimi k2.5", 262_144, "Moonshot Kimi K2.5"),
  model("moonshot kimi k2 0905", 262_144, "Moonshot Kimi K2 0905"),
  model("moonshot kimi k2 turbo", 262_144, "Moonshot Kimi K2 Turbo"),
  model("moonshot kimi k2 thinking", 262_144, "Moonshot Kimi K2 Thinking"),
  model("moonshot kimi k2 0711", 131_072, "Moonshot Kimi K2 0711"),
  model("moonshot kimi k2", 262_144, "Moonshot Kimi K2"),
  model("kimi k2.6", 262_144, "Moonshot Kimi K2.6"),
  model("kimi k2.5", 262_144, "Moonshot Kimi K2.5"),
  model("kimi k2 0905", 262_144, "Moonshot Kimi K2 0905"),
  model("kimi k2 turbo", 262_144, "Moonshot Kimi K2 Turbo"),
  model("kimi k2 thinking", 262_144, "Moonshot Kimi K2 Thinking"),
  model("kimi k2 0711", 131_072, "Moonshot Kimi K2 0711"),
  model("kimi k2", 262_144, "Moonshot Kimi K2"),
  model("kimi latest", 262_144, "Moonshot Kimi latest"),
  model("moonshot v1 128k", 131_072, "Moonshot v1 128k"),
  model("moonshot v1 32k", 32_768, "Moonshot v1 32k"),
  model("moonshot v1 8k", 8_192, "Moonshot v1 8k"),
  model("moonshot", 131_072, "Moonshot default"),

  // DeepSeek
  model("deepseek v4", 1_000_000, "DeepSeek V4"),
  model("deepseek chat", 1_000_000, "DeepSeek chat alias"),
  model("deepseek reasoner", 1_000_000, "DeepSeek reasoner alias"),
  model("deepseek v3.2", 128_000, "DeepSeek V3.2"),
  model("deepseek v3", 128_000, "DeepSeek V3"),
  model("deepseek r1", 64_000, "DeepSeek R1"),
  model("deepseek", 128_000, "DeepSeek default"),

  // Qwen / Alibaba Model Studio
  model("qwen 3.6 plus", 1_000_000, "Qwen3.6 Plus"),
  model("qwen 3.5 plus", 1_000_000, "Qwen3.5 Plus"),
  model("qwen 3 coder plus", 1_000_000, "Qwen3 Coder Plus"),
  model("qwen 3 coder next", 262_144, "Qwen3 Coder Next"),
  model("qwen 3 max", 262_144, "Qwen3 Max"),
  model("qwen3 max", 262_144, "Qwen3 Max"),
  model("qwen max", 262_144, "Qwen Max"),
  model("qwen long", 1_000_000, "Qwen long-context"),
  model("qwen flash", 1_000_000, "Qwen Flash"),
  model("qwen turbo", 1_000_000, "Qwen Turbo"),
  model("qwen plus", 1_000_000, "Qwen Plus"),
  model("qwq", 32_768, "QwQ"),
  model("qwen", 131_072, "Qwen default"),

  // Mistral
  model("mistral large 3", 256_000, "Mistral Large 3"),
  model("mistral large latest", 256_000, "Mistral Large latest"),
  model("mistral small 4", 256_000, "Mistral Small 4"),
  model("mistral medium 3.5", 256_000, "Mistral Medium 3.5"),
  model("mistral large", 131_072, "Mistral Large"),
  model("pixtral large", 131_072, "Mistral Pixtral Large"),
  model("ministral 3", 131_072, "Mistral Ministral 3"),
  model("mistral medium", 32_768, "Mistral Medium"),
  model("mistral small", 32_768, "Mistral Small"),
  model("codestral", 32_768, "Mistral Codestral"),
  model("magistral", 32_768, "Mistral Magistral"),
  model("mistral", 32_768, "Mistral default"),

  // xAI
  model("grok 4.20", 2_000_000, "xAI Grok 4.20"),
  model("grok 4.1 fast", 2_000_000, "xAI Grok 4.1 Fast"),
  model("grok 4 fast", 2_000_000, "xAI Grok 4 Fast"),
  model("grok code fast", 256_000, "xAI Grok Code Fast"),
  model("grok 4", 256_000, "xAI Grok 4"),
  model("grok 3", 131_072, "xAI Grok 3"),
  model("grok", 256_000, "xAI Grok default"),

  // Other common hosted model families
  model("llama 4 scout", 10_000_000, "Meta Llama 4 Scout"),
  model("llama 4 maverick", 1_000_000, "Meta Llama 4 Maverick"),
  model("llama 3.3", 131_072, "Meta Llama 3.3"),
  model("llama 3.1", 131_072, "Meta Llama 3.1"),
  model("command a", 256_000, "Cohere Command A"),
  model("command r", 131_072, "Cohere Command R"),
  model("glm 5", 202_752, "Zhipu GLM-5"),
  model("glm 4.7", 202_752, "Zhipu GLM-4.7"),
  model("glm 4.5", 131_072, "Zhipu GLM-4.5"),
  model("minimax m2.5", 204_800, "MiniMax M2.5")
].sort(comparePatternSpecificity);

export function resolveModelContextWindow(
  modelName: string,
  overrides: ModelContextWindowOverrides = {}
): ContextWindowResolution {
  const override = findOverride(modelName, overrides);
  if (override) {
    return override;
  }

  const explicit = inferExplicitContextWindow(modelName);
  if (explicit) {
    return explicit;
  }

  const builtin = findBuiltin(modelName);
  if (builtin) {
    return builtin;
  }

  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW_TOKENS,
    source: "fallback",
    label: "fallback default"
  };
}

export function normalizeModelContextWindowOverrides(
  overrides: ModelContextWindowOverrides | undefined
): ModelContextWindowOverrides {
  if (!overrides) {
    return {};
  }

  const normalized: ModelContextWindowOverrides = {};
  for (const [pattern, rawValue] of Object.entries(overrides)) {
    const normalizedPattern = pattern.trim();
    const value = normalizeContextWindowTokenCount(rawValue);
    if (!normalizedPattern || value === undefined) {
      continue;
    }

    normalized[normalizedPattern] = value;
  }

  return normalized;
}

function findOverride(
  modelName: string,
  overrides: ModelContextWindowOverrides
): ContextWindowResolution | null {
  const patterns = Object.entries(normalizeModelContextWindowOverrides(overrides))
    .map(([pattern, contextWindow]) => model(pattern, contextWindow, `override: ${pattern}`))
    .sort(comparePatternSpecificity);
  const matched = findMatchingPattern(modelName, patterns);
  if (!matched) {
    return null;
  }

  return {
    contextWindow: matched.contextWindow,
    source: "override",
    matchedPattern: matched.pattern,
    label: matched.label
  };
}

function inferExplicitContextWindow(modelName: string): ContextWindowResolution | null {
  const normalized = modelName.toLowerCase();
  const match = normalized.match(
    /(?:^|[^a-z0-9])(?:(?:ctx|context|window|longctx|long-context|long_context)[^a-z0-9]*)?(\d+(?:\.\d+)?)\s*([km])(?:$|[^a-z0-9])/i
  );
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(amount) || !unit) {
    return null;
  }

  const contextWindow = normalizeContextWindowTokenCount(
    unit === "m" ? amount * 1_000_000 : amount * 1024
  );
  if (contextWindow === undefined) {
    return null;
  }

  return {
    contextWindow,
    source: "model_name",
    matchedPattern: match[0].trim(),
    label: `model name suffix: ${match[0].trim()}`
  };
}

function findBuiltin(modelName: string): ContextWindowResolution | null {
  const matched = findMatchingPattern(modelName, BUILTIN_CONTEXT_WINDOWS);
  if (!matched) {
    return null;
  }

  return {
    contextWindow: matched.contextWindow,
    source: "builtin",
    matchedPattern: matched.pattern,
    label: matched.label
  };
}

function findMatchingPattern(
  modelName: string,
  patterns: ContextWindowPattern[]
): ContextWindowPattern | null {
  const modelTokens = tokenizeModelName(modelName);
  for (const pattern of patterns) {
    if (containsContiguousTokenSequence(patternTokens(pattern), modelTokens)) {
      return pattern;
    }
  }

  return null;
}

function patternTokens(pattern: ContextWindowPattern): string[] {
  return tokenizeModelName(pattern.pattern);
}

function tokenizeModelName(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/(?<=\d)[_-](?=\d{1,2}(?:\D|$))/gu, ".")
    .replace(/(?<=[a-z])(?=\d)/gu, " ")
    .replace(/(?<=\d)(?=[a-z])/gu, " ")
    .match(/[a-z]+|\d+(?:\.\d+)*/gu) ?? [];
}

function containsContiguousTokenSequence(patternTokens: string[], modelTokens: string[]): boolean {
  if (patternTokens.length === 0 || modelTokens.length === 0) {
    return false;
  }

  for (let startIndex = 0; startIndex <= modelTokens.length - patternTokens.length; startIndex += 1) {
    let matched = true;
    for (let patternIndex = 0; patternIndex < patternTokens.length; patternIndex += 1) {
      if (modelTokens[startIndex + patternIndex] !== patternTokens[patternIndex]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return true;
    }
  }

  return false;
}

function model(pattern: string, contextWindow: number, label: string): ContextWindowPattern {
  return {
    pattern,
    contextWindow,
    label
  };
}

function comparePatternSpecificity(left: ContextWindowPattern, right: ContextWindowPattern): number {
  const leftTokens = patternTokens(left);
  const rightTokens = patternTokens(right);
  return (
    rightTokens.length - leftTokens.length ||
    right.pattern.length - left.pattern.length ||
    right.contextWindow - left.contextWindow
  );
}

function normalizeContextWindowTokenCount(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  if (normalized < 4_000 || normalized > 10_000_000) {
    return undefined;
  }

  return normalized;
}
