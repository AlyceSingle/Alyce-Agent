import { readFileSync } from "node:fs";
import path from "node:path";

export interface PromptOverrideConfig {
  languagePreference?: string;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
}

export interface MemoryRuntimeConfig {
  directory: string;
  fileName: string;
  maxSessionEntries: number;
  maxPersistentEntries: number;
  maxPromptEntries: number;
  autoSummary: {
    enabled: boolean;
    minMessagesToInit: number;
    messagesBetweenUpdates: number;
    windowMessages: number;
    maxCharsPerMessage: number;
  };
}

// 运行时配置：统一收口环境变量与命令行参数解析结果。
export interface RuntimeConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  workspaceRoot: string;
  maxSteps: number;
  commandTimeoutMs: number;
  autoApprove: boolean;
  prompt: PromptOverrideConfig;
  memory: MemoryRuntimeConfig;
}

export function parseRuntimeConfig(argv: string[], env: NodeJS.ProcessEnv): RuntimeConfig {
  const apiKey = env.OPENAI_API_KEY;
  // 启动即校验 API Key，避免进入主流程后才报错。
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required. Copy .env.example to .env and set it.");
  }

  // system prompt 支持「命令行直传 / 文件路径 / 环境变量」三种来源。
  const customSystemPrompt = resolvePromptText({
    argv,
    directFlag: "--system-prompt",
    fileFlag: "--system-prompt-file",
    envValue: env.AGENT_SYSTEM_PROMPT,
    label: "system prompt"
  });

  // append system prompt 与主 system prompt 保持一致的解析规则。
  const appendSystemPrompt = resolvePromptText({
    argv,
    directFlag: "--append-system-prompt",
    fileFlag: "--append-system-prompt-file",
    envValue: env.AGENT_APPEND_SYSTEM_PROMPT,
    label: "append system prompt"
  });

  const languagePreference = getArgValue(argv, "--lang") || env.AGENT_LANGUAGE || undefined;

  // 参数优先级：CLI 参数 > 环境变量 > 默认值。
  return {
    apiKey,
    baseURL: env.OPENAI_BASE_URL || undefined,
    model: getArgValue(argv, "--model") || env.OPENAI_MODEL || "gemini-3-flash-preview",
    workspaceRoot: path.resolve(getArgValue(argv, "--cwd") || env.AGENT_WORKSPACE || "."),
    maxSteps: parsePositiveInt(env.AGENT_MAX_STEPS, 8),
    commandTimeoutMs: parsePositiveInt(env.AGENT_COMMAND_TIMEOUT_MS, 120_000),
    autoApprove: hasFlag(argv, "--yolo"),
    prompt: {
      languagePreference,
      customSystemPrompt,
      appendSystemPrompt
    },
    memory: {
      directory: env.AGENT_MEMORY_DIR || ".alyce/memory",
      fileName: env.AGENT_MEMORY_FILE || "MEMORY.md",
      maxSessionEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_SESSION, 30),
      maxPersistentEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PERSISTENT, 200),
      maxPromptEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PROMPT, 20),
      autoSummary: {
        enabled: parseBoolean(env.AGENT_MEMORY_AUTO_SUMMARY, true),
        minMessagesToInit: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_MIN_MESSAGES, 8),
        messagesBetweenUpdates: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_INTERVAL_MESSAGES, 6),
        windowMessages: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_WINDOW_MESSAGES, 28),
        maxCharsPerMessage: parsePositiveInt(env.AGENT_MEMORY_SUMMARY_MAX_CHARS_PER_MESSAGE, 1000)
      }
    }
  };
}

function resolvePromptText(options: {
  argv: string[];
  directFlag: string;
  fileFlag: string;
  envValue?: string;
  label: string;
}): string | undefined {
  const directValue = getArgValue(options.argv, options.directFlag);
  const fileValue = getArgValue(options.argv, options.fileFlag);

  // 直传内容和文件输入语义冲突，显式禁止同时使用。
  if (directValue && fileValue) {
    throw new Error(`Cannot use ${options.directFlag} and ${options.fileFlag} at the same time.`);
  }

  if (fileValue) {
    const absolutePath = path.resolve(fileValue);
    try {
      return readFileSync(absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 保留原始错误信息，便于定位路径权限或文件不存在问题。
      throw new Error(`Failed to read ${options.label} file: ${absolutePath}. ${message}`);
    }
  }

  return directValue ?? options.envValue;
}

function getArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  // 仅支持 "--flag value" 形式；缺失 value 时返回 undefined。
  return argv[index + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  // 仅判断标记是否存在，不解析后续值。
  return argv.includes(flag);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  // 统一截断为不小于 1 的整数，避免 0/负数导致配置失效。
  return Math.max(1, Math.trunc(parsed));
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return fallback;
}
