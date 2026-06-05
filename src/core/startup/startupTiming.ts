import process from "node:process";
import { performance } from "node:perf_hooks";

const STARTUP_TIMING_STATE = Symbol.for("alyce.startupTiming");

type StartupTimingDetails = Record<string, unknown> | string;

type StartupTimingState = {
  enabled: boolean;
  startedAtMs: number;
};

type StartupTimingGlobal = typeof globalThis & {
  [STARTUP_TIMING_STATE]?: StartupTimingState;
};

function getStartupTimingState(env: NodeJS.ProcessEnv = process.env): StartupTimingState {
  const globalState = globalThis as StartupTimingGlobal;
  const existing = globalState[STARTUP_TIMING_STATE];
  if (existing) {
    return existing;
  }

  const created: StartupTimingState = {
    enabled: parseStartupTimingEnabled(env),
    startedAtMs: performance.now()
  };
  globalState[STARTUP_TIMING_STATE] = created;
  return created;
}

export function isStartupTimingEnabled(env?: NodeJS.ProcessEnv): boolean {
  return getStartupTimingState(env).enabled;
}

export function logStartupTiming(label: string, details?: StartupTimingDetails): void {
  const state = getStartupTimingState();
  if (!state.enabled) {
    return;
  }

  const elapsedMs = performance.now() - state.startedAtMs;
  const suffix = details === undefined ? "" : ` ${formatStartupTimingDetails(details)}`;
  process.stderr.write(`[alyce startup +${elapsedMs.toFixed(1)}ms] ${label}${suffix}\n`);
}

export async function measureStartupTiming<T>(
  label: string,
  run: () => Promise<T> | T,
  details?: StartupTimingDetails
): Promise<T> {
  const state = getStartupTimingState();
  if (!state.enabled) {
    return await run();
  }

  const stepStartedAtMs = performance.now();
  logStartupTiming(`${label}:start`, details);
  try {
    const result = await run();
    logStartupTiming(`${label}:end`, {
      stepMs: Number((performance.now() - stepStartedAtMs).toFixed(1))
    });
    return result;
  } catch (error) {
    logStartupTiming(`${label}:error`, {
      stepMs: Number((performance.now() - stepStartedAtMs).toFixed(1)),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function parseStartupTimingEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ALYCE_STARTUP_TIMING ?? env.AGENT_STARTUP_TIMING;
  if (!raw) {
    return false;
  }

  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

function formatStartupTimingDetails(details: StartupTimingDetails): string {
  if (typeof details === "string") {
    return details;
  }

  return Object.entries(details)
    .map(([key, value]) => `${key}=${formatStartupTimingValue(value)}`)
    .join(" ");
}

function formatStartupTimingValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}
