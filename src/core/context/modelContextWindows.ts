export type ContextWindowSource = "override" | "model_name" | "fallback";

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

// 无 provider 活数据时的兜底链：override → 名称后缀(128k/1m) → 默认 128k。
// 正常路径应优先用 /models 发现或 provider 预设写入的 contextWindow（见 resolveModelProfile）。
// 已移除内置型号穷举表：数据易过期且会与真实网关元数据冲突。
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

// 从模型 id 里读显式窗口，例如 foo-128k / bar-1m / ctx-200k。
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
