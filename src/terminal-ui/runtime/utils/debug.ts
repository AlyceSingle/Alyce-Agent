import { isEnvTruthy } from "./envUtils.js";

export type DebugLogLevel = "verbose" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4
};

function getMinDebugLogLevel(): DebugLogLevel {
  const raw = process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim();
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel;
  }

  return "debug";
}

function isDebugEnabled(): boolean {
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
  if (!isDebugEnabled()) {
    return;
  }

  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return;
  }

  const output = `${new Date().toISOString()} [${level.toUpperCase()}] ${message.trim()}\n`;

  try {
    process.stderr.write(output);
  } catch {
    // Ignore debug write failures.
  }
}
