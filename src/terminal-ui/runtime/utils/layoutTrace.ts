import { logForDebugging } from "./debug.js";
import { isEnvTruthy } from "./envUtils.js";

type TraceState = {
  lastLoggedAtMs: number;
  lastPayload: string;
  suppressedCount: number;
};

const DEFAULT_TRACE_MIN_INTERVAL_MS = 200;
const traceStateByEvent = new Map<string, TraceState>();

function getTraceMinIntervalMs() {
  const raw = process.env.ALYCE_LAYOUT_TRACE_MIN_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TRACE_MIN_INTERVAL_MS;
  }

  return Math.floor(parsed);
}

export function isLayoutTraceEnabled(): boolean {
  return isEnvTruthy(process.env.ALYCE_LAYOUT_TRACE);
}

export function logLayoutTrace(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
  if (!isLayoutTraceEnabled()) {
    return;
  }

  const details = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const payload = `[layout-trace] ${event}${details.length > 0 ? ` ${details}` : ""}`;
  const nowMs = Date.now();
  const minIntervalMs = getTraceMinIntervalMs();
  const previous = traceStateByEvent.get(event);

  if (previous) {
    const tooSoon = nowMs - previous.lastLoggedAtMs < minIntervalMs;
    const repeated = previous.lastPayload === payload;
    if (tooSoon || repeated) {
      previous.suppressedCount += 1;
      previous.lastPayload = payload;
      return;
    }

    if (previous.suppressedCount > 0) {
      logForDebugging(
        `[layout-trace] ${event} suppressed=${previous.suppressedCount}`,
        { level: "verbose" }
      );
    }

    previous.suppressedCount = 0;
    previous.lastLoggedAtMs = nowMs;
    previous.lastPayload = payload;
  } else {
    traceStateByEvent.set(event, {
      lastLoggedAtMs: nowMs,
      lastPayload: payload,
      suppressedCount: 0
    });
  }

  logForDebugging(payload, { level: "debug" });
}
