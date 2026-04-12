import { readFileSync } from "node:fs";
import path from "node:path";

export interface PromptOverrideConfig {
  languagePreference?: string;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
}

export interface RuntimeConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  workspaceRoot: string;
  maxSteps: number;
  commandTimeoutMs: number;
  autoApprove: boolean;
  prompt: PromptOverrideConfig;
}

export function parseRuntimeConfig(argv: string[], env: NodeJS.ProcessEnv): RuntimeConfig {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required. Copy .env.example to .env and set it.");
  }

  const customSystemPrompt = resolvePromptText({
    argv,
    directFlag: "--system-prompt",
    fileFlag: "--system-prompt-file",
    envValue: env.AGENT_SYSTEM_PROMPT,
    label: "system prompt"
  });

  const appendSystemPrompt = resolvePromptText({
    argv,
    directFlag: "--append-system-prompt",
    fileFlag: "--append-system-prompt-file",
    envValue: env.AGENT_APPEND_SYSTEM_PROMPT,
    label: "append system prompt"
  });

  const languagePreference = getArgValue(argv, "--lang") || env.AGENT_LANGUAGE || undefined;

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

  if (directValue && fileValue) {
    throw new Error(`Cannot use ${options.directFlag} and ${options.fileFlag} at the same time.`);
  }

  if (fileValue) {
    const absolutePath = path.resolve(fileValue);
    try {
      return readFileSync(absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

  return argv[index + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
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

  return Math.max(1, Math.trunc(parsed));
}
