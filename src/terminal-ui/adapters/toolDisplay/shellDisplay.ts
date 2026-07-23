import type { TerminalUiToolShellResult } from "../../state/types.js";
import {
  asBoolean,
  asNullableNumber,
  asNullableString,
  asNumber,
  asRecord,
  asString
} from "./common.js";

// Shell 结构化结果解析。

export function toShellResult(value: unknown): TerminalUiToolShellResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const command = asString(record.command);
  const cwd = asString(record.cwd);
  const stdout = asString(record.stdout);
  const stderr = asString(record.stderr);
  const durationMs = asNumber(record.durationMs);
  const timedOut = asBoolean(record.timedOut);

  if (!command || !cwd || stdout === undefined || stderr === undefined || durationMs === undefined || timedOut === undefined) {
    return null;
  }

  return {
    command,
    cwd,
    exitCode: asNullableNumber(record.exitCode),
    signal: asNullableString(record.signal),
    timedOut,
    stdout,
    stderr,
    durationMs
  };
}

export function formatExitState(result: TerminalUiToolShellResult) {
  if (result.exitCode !== null) {
    return String(result.exitCode);
  }

  if (result.signal) {
    return result.signal;
  }

  return result.timedOut ? "timeout" : "unknown";
}
