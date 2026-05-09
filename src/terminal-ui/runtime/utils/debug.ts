import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isEnvTruthy } from "./envUtils.js";

export type DebugLogLevel = "verbose" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4
};

let initializedDebugLogFilePath = false;
let debugLogFilePath: string | null = null;

function getDebugLogFilePath(): string | null {
  if (initializedDebugLogFilePath) {
    return debugLogFilePath;
  }

  initializedDebugLogFilePath = true;
  const configuredPath =
    process.env.ALYCE_DEBUG_LOG_FILE?.trim() ||
    process.env.CLAUDE_CODE_DEBUG_LOG_FILE?.trim() ||
    "";
  if (!configuredPath) {
    debugLogFilePath = null;
    return debugLogFilePath;
  }

  const absolutePath = resolve(configuredPath);
  try {
    mkdirSync(dirname(absolutePath), { recursive: true });
    debugLogFilePath = absolutePath;
  } catch {
    debugLogFilePath = null;
  }

  return debugLogFilePath;
}

function getMinDebugLogLevel(): DebugLogLevel {
  const raw = process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim();
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel;
  }

  return "debug";
}

function isStderrDebugEnabled(): boolean {
  return (
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.CLAUDE_CODE_DEBUG) ||
    process.argv.includes("--debug") ||
    process.argv.includes("-d")
  );
}

export function logForDebugging(
  message: string,
  { level = "debug" }: { level?: DebugLogLevel } = {}
): void {
  const stderrEnabled = isStderrDebugEnabled();
  const logFilePath = getDebugLogFilePath();
  if (!stderrEnabled && !logFilePath) {
    return;
  }

  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return;
  }

  const output = `${new Date().toISOString()} [${level.toUpperCase()}] ${message.trim()}\n`;

  if (stderrEnabled) {
    try {
      process.stderr.write(output);
    } catch {
      // Ignore debug write failures.
    }
  }

  if (!logFilePath) {
    return;
  }

  try {
    appendFileSync(logFilePath, output, { encoding: "utf8" });
  } catch {
    // Ignore debug write failures.
  }
}
