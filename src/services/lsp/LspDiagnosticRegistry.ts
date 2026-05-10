import { randomUUID } from "node:crypto";

const MAX_RETAINED_COMPLETED_EVENTS = 100;
const MAX_ERROR_MESSAGE_CHARS = 1_000;
const DEFAULT_MAX_ISSUES_PER_EVENT = 20;
const DEFAULT_PENDING_TIMEOUT_MS = 120_000;
const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 300_000;

export type LspDiagnosticSource = "post-write" | "lsp";
export type LspDiagnosticCompletedStatus = "ok" | "issues" | "failed";
export type LspDiagnosticResultStatus =
  | "skipped"
  | "pending"
  | LspDiagnosticCompletedStatus;
export type LspDiagnosticCompletionReason =
  | "completed"
  | "timeout"
  | "circuit-breaker";

export interface LspDiagnosticIssue {
  filePath: string;
  line: number;
  character: number;
  severity: string;
  code: string;
  message: string;
  source?: string;
}

export interface LspDiagnosticPromiseResult {
  status: LspDiagnosticResultStatus;
  backend?: string;
  issues: LspDiagnosticIssue[];
  totalIssueCount: number;
  truncated: boolean;
  message?: string;
}

export interface LspDiagnosticPendingRecord {
  id: string;
  source: LspDiagnosticSource;
  filePath: string;
  backend?: string;
  startedAt: string;
  startedAtMs: number;
}

export interface LspDiagnosticCompletedEvent {
  id: string;
  source: LspDiagnosticSource;
  filePath: string;
  backend?: string;
  status: LspDiagnosticCompletedStatus;
  issues: LspDiagnosticIssue[];
  totalIssueCount: number;
  truncated: boolean;
  message?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  completionReason: LspDiagnosticCompletionReason;
  originalIssueCount: number;
  duplicateIssueCount: number;
  omittedIssueCount: number;
  groupedFileCount: number;
  failureStreak: number;
  circuitBreakerOpen: boolean;
  circuitBreakerOpenUntil?: string;
}

export interface LspDiagnosticRegistryOptions {
  maxIssuesPerEvent: number;
  pendingTimeoutMs: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerCooldownMs: number;
}

type DiagnosticCompletedListener = (event: LspDiagnosticCompletedEvent) => void;

type LspDiagnosticCircuitState = {
  failureStreak: number;
  openUntilMs: number | null;
};

type NormalizedDiagnosticIssues = {
  issues: LspDiagnosticIssue[];
  originalIssueCount: number;
  duplicateIssueCount: number;
  omittedIssueCount: number;
  groupedFileCount: number;
  truncated: boolean;
};

export class LspDiagnosticRegistry {
  private readonly pending = new Map<string, LspDiagnosticPendingRecord>();
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
  private readonly completed: LspDiagnosticCompletedEvent[] = [];
  private readonly completedIds = new Set<string>();
  private readonly completedListeners = new Set<DiagnosticCompletedListener>();
  private readonly circuitStateByBackend = new Map<string, LspDiagnosticCircuitState>();
  private options: LspDiagnosticRegistryOptions;

  constructor(options: Partial<LspDiagnosticRegistryOptions> = {}) {
    this.options = normalizeOptions(options);
  }

  registerPendingDiagnostics(options: {
    id?: string;
    source: LspDiagnosticSource;
    filePath: string;
    backend?: string;
    startedAtMs: number;
    diagnosticsPromise: Promise<LspDiagnosticPromiseResult>;
  }): string {
    const id = options.id ?? randomUUID();
    if (this.pending.has(id) || this.completedIds.has(id)) {
      return id;
    }

    const circuitState = this.getCircuitState(options.backend);
    if (this.isCircuitOpen(circuitState)) {
      this.publishCompletedDiagnostics({
        id,
        source: options.source,
        filePath: options.filePath,
        backend: options.backend,
        status: "failed",
        issues: [],
        totalIssueCount: 0,
        truncated: false,
        message: `Diagnostics are temporarily disabled after repeated failures. Retrying after ${new Date(circuitState.openUntilMs ?? Date.now()).toISOString()}.`,
        startedAtMs: options.startedAtMs,
        completedAtMs: Date.now(),
        completionReason: "circuit-breaker"
      });
      return id;
    }

    const pendingRecord: LspDiagnosticPendingRecord = {
      id,
      source: options.source,
      filePath: options.filePath,
      backend: options.backend,
      startedAt: new Date(options.startedAtMs).toISOString(),
      startedAtMs: options.startedAtMs
    };
    this.pending.set(id, pendingRecord);
    this.schedulePendingTimeout(id);

    void options.diagnosticsPromise.then((result) => {
      this.completePendingDiagnostics(id, result);
    }).catch((error) => {
      this.completePendingDiagnostics(id, {
        status: "failed",
        backend: options.backend,
        issues: [],
        totalIssueCount: 0,
        truncated: false,
        message: truncateErrorMessage(error)
      });
    });

    return id;
  }

  publishCompletedDiagnostics(options: {
    id?: string;
    source: LspDiagnosticSource;
    filePath: string;
    backend?: string;
    status: LspDiagnosticCompletedStatus;
    issues: LspDiagnosticIssue[];
    totalIssueCount: number;
    truncated: boolean;
    message?: string;
    startedAtMs?: number;
    completedAtMs?: number;
    completionReason?: LspDiagnosticCompletionReason;
  }): string {
    const id = options.id ?? randomUUID();
    if (this.completedIds.has(id)) {
      return id;
    }

    const completedAtMs = options.completedAtMs ?? Date.now();
    const startedAtMs = options.startedAtMs ?? completedAtMs;
    const event = this.createCompletedEvent({
      id,
      source: options.source,
      filePath: options.filePath,
      backend: options.backend,
      status: options.status,
      issues: options.issues,
      totalIssueCount: options.totalIssueCount,
      truncated: options.truncated,
      message: options.message,
      startedAtMs,
      completedAtMs,
      completionReason: options.completionReason ?? "completed"
    });

    this.publishCompletedEvent(event);
    return id;
  }

  subscribeCompleted(listener: DiagnosticCompletedListener): () => void {
    this.completedListeners.add(listener);
    return () => {
      this.completedListeners.delete(listener);
    };
  }

  getPendingSnapshot(): LspDiagnosticPendingRecord[] {
    return [...this.pending.values()].map((record) => ({ ...record }));
  }

  getCompletedEventsSnapshot(): LspDiagnosticCompletedEvent[] {
    return this.completed.map(cloneCompletedEvent);
  }

  getCircuitBreakerSnapshot() {
    const now = Date.now();
    return [...this.circuitStateByBackend.entries()].map(([backend, state]) => ({
      backend,
      failureStreak: state.failureStreak,
      open: state.openUntilMs !== null && state.openUntilMs > now,
      openUntil: state.openUntilMs === null ? undefined : new Date(state.openUntilMs).toISOString()
    }));
  }

  configure(options: Partial<LspDiagnosticRegistryOptions>) {
    this.options = normalizeOptions({
      ...this.options,
      ...options
    });
    for (const [id, timer] of this.pendingTimers.entries()) {
      clearTimeout(timer);
      this.pendingTimers.delete(id);
      this.schedulePendingTimeout(id);
    }
  }

  resetForTesting(options: Partial<LspDiagnosticRegistryOptions> = {}) {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.pendingTimers.clear();
    this.completed.splice(0);
    this.completedIds.clear();
    this.completedListeners.clear();
    this.circuitStateByBackend.clear();
    this.options = normalizeOptions(options);
  }

  private completePendingDiagnostics(
    id: string,
    result: LspDiagnosticPromiseResult
  ) {
    const pendingRecord = this.pending.get(id);
    if (!pendingRecord || this.completedIds.has(id)) {
      return;
    }

    this.pending.delete(id);
    this.clearPendingTimer(id);
    const status = toCompletedStatus(result.status);
    if (!status) {
      return;
    }

    const completedAtMs = Date.now();
    this.publishCompletedEvent(this.createCompletedEvent({
      id,
      source: pendingRecord.source,
      filePath: pendingRecord.filePath,
      backend: result.backend ?? pendingRecord.backend,
      status,
      issues: result.issues,
      totalIssueCount: result.totalIssueCount,
      truncated: result.truncated,
      message: result.message,
      startedAtMs: pendingRecord.startedAtMs,
      completedAtMs,
      completionReason: "completed"
    }));
  }

  private completePendingDiagnosticsAsTimedOut(id: string) {
    const pendingRecord = this.pending.get(id);
    if (!pendingRecord || this.completedIds.has(id)) {
      return;
    }

    this.pending.delete(id);
    this.pendingTimers.delete(id);
    const completedAtMs = Date.now();
    this.publishCompletedEvent(this.createCompletedEvent({
      id,
      source: pendingRecord.source,
      filePath: pendingRecord.filePath,
      backend: pendingRecord.backend,
      status: "failed",
      issues: [],
      totalIssueCount: 0,
      truncated: false,
      message: `Diagnostics timed out after ${this.options.pendingTimeoutMs}ms.`,
      startedAtMs: pendingRecord.startedAtMs,
      completedAtMs,
      completionReason: "timeout"
    }));
  }

  private createCompletedEvent(options: {
    id: string;
    source: LspDiagnosticSource;
    filePath: string;
    backend?: string;
    status: LspDiagnosticCompletedStatus;
    issues: LspDiagnosticIssue[];
    totalIssueCount: number;
    truncated: boolean;
    message?: string;
    startedAtMs: number;
    completedAtMs: number;
    completionReason: LspDiagnosticCompletionReason;
  }): LspDiagnosticCompletedEvent {
    const normalizedIssues = normalizeDiagnosticIssues(
      options.issues,
      this.options.maxIssuesPerEvent
    );
    const circuitState = this.recordCircuitOutcome(options.backend, options.status);
    return {
      id: options.id,
      source: options.source,
      filePath: options.filePath,
      backend: options.backend,
      status: options.status,
      issues: normalizedIssues.issues,
      totalIssueCount: Math.max(0, Math.trunc(options.totalIssueCount)),
      truncated: options.truncated || normalizedIssues.truncated,
      message: options.message,
      startedAt: new Date(options.startedAtMs).toISOString(),
      completedAt: new Date(options.completedAtMs).toISOString(),
      durationMs: Math.max(0, Math.trunc(options.completedAtMs - options.startedAtMs)),
      completionReason: options.completionReason,
      originalIssueCount: normalizedIssues.originalIssueCount,
      duplicateIssueCount: normalizedIssues.duplicateIssueCount,
      omittedIssueCount: normalizedIssues.omittedIssueCount,
      groupedFileCount: normalizedIssues.groupedFileCount,
      failureStreak: circuitState.failureStreak,
      circuitBreakerOpen: this.isCircuitOpen(circuitState),
      ...(circuitState.openUntilMs !== null
        ? { circuitBreakerOpenUntil: new Date(circuitState.openUntilMs).toISOString() }
        : {})
    };
  }

  private publishCompletedEvent(event: LspDiagnosticCompletedEvent) {
    this.clearPendingTimer(event.id);
    if (this.completedIds.has(event.id)) {
      return;
    }

    this.completed.push(event);
    this.completedIds.add(event.id);
    while (this.completed.length > MAX_RETAINED_COMPLETED_EVENTS) {
      const removed = this.completed.shift();
      if (removed) {
        this.completedIds.delete(removed.id);
      }
    }

    for (const listener of [...this.completedListeners]) {
      try {
        listener(event);
      } catch {
        // Diagnostic publication must not break tool execution or the UI loop.
      }
    }
  }

  private schedulePendingTimeout(id: string) {
    this.clearPendingTimer(id);
    const timeoutMs = this.options.pendingTimeoutMs;
    const timeout = setTimeout(() => {
      this.completePendingDiagnosticsAsTimedOut(id);
    }, timeoutMs);
    this.pendingTimers.set(id, timeout);
  }

  private clearPendingTimer(id: string) {
    const timeout = this.pendingTimers.get(id);
    if (!timeout) {
      return;
    }

    clearTimeout(timeout);
    this.pendingTimers.delete(id);
  }

  private getCircuitState(backend: string | undefined): LspDiagnosticCircuitState {
    const key = backend ?? "unknown";
    let state = this.circuitStateByBackend.get(key);
    if (!state) {
      state = {
        failureStreak: 0,
        openUntilMs: null
      };
      this.circuitStateByBackend.set(key, state);
    }

    return state;
  }

  private recordCircuitOutcome(
    backend: string | undefined,
    status: LspDiagnosticCompletedStatus
  ): LspDiagnosticCircuitState {
    const state = this.getCircuitState(backend);
    const now = Date.now();

    if (state.openUntilMs !== null && state.openUntilMs <= now) {
      state.openUntilMs = null;
      state.failureStreak = 0;
    }

    if (status === "failed") {
      state.failureStreak += 1;
      if (state.failureStreak >= this.options.circuitBreakerFailureThreshold) {
        state.openUntilMs = now + this.options.circuitBreakerCooldownMs;
      }
      return state;
    }

    state.failureStreak = 0;
    state.openUntilMs = null;
    return state;
  }

  private isCircuitOpen(state: LspDiagnosticCircuitState) {
    if (state.openUntilMs === null) {
      return false;
    }

    if (state.openUntilMs > Date.now()) {
      return true;
    }

    state.openUntilMs = null;
    state.failureStreak = 0;
    return false;
  }
}

export const lspDiagnosticRegistry = new LspDiagnosticRegistry();

export function registerPendingPostWriteDiagnostics(options: {
  id?: string;
  filePath: string;
  backend?: string;
  startedAtMs: number;
  diagnosticsPromise: Promise<LspDiagnosticPromiseResult>;
}) {
  return lspDiagnosticRegistry.registerPendingDiagnostics({
    ...options,
    source: "post-write"
  });
}

export function getLspDiagnosticRegistry() {
  return lspDiagnosticRegistry;
}

export const __LSP_DIAGNOSTIC_REGISTRY_TESTING__ = {
  reset: (options?: Partial<LspDiagnosticRegistryOptions>) =>
    lspDiagnosticRegistry.resetForTesting(options),
  normalizeDiagnosticIssues
};

function normalizeOptions(
  options: Partial<LspDiagnosticRegistryOptions>
): LspDiagnosticRegistryOptions {
  return {
    maxIssuesPerEvent: clampPositiveInt(options.maxIssuesPerEvent, DEFAULT_MAX_ISSUES_PER_EVENT),
    pendingTimeoutMs: clampPositiveInt(options.pendingTimeoutMs, DEFAULT_PENDING_TIMEOUT_MS),
    circuitBreakerFailureThreshold: clampPositiveInt(
      options.circuitBreakerFailureThreshold,
      DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD
    ),
    circuitBreakerCooldownMs: clampPositiveInt(
      options.circuitBreakerCooldownMs,
      DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS
    )
  };
}

function normalizeDiagnosticIssues(
  issues: readonly LspDiagnosticIssue[],
  maxIssuesPerEvent: number
): NormalizedDiagnosticIssues {
  const dedupedIssues: LspDiagnosticIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = formatIssueKey(issue);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    dedupedIssues.push({ ...issue });
  }

  const maxIssues = Math.max(1, Math.trunc(maxIssuesPerEvent));
  const displayIssues = dedupedIssues.slice(0, maxIssues);
  const omittedIssueCount = Math.max(0, dedupedIssues.length - displayIssues.length);
  return {
    issues: displayIssues,
    originalIssueCount: issues.length,
    duplicateIssueCount: issues.length - dedupedIssues.length,
    omittedIssueCount,
    groupedFileCount: new Set(dedupedIssues.map((issue) => issue.filePath)).size,
    truncated: omittedIssueCount > 0
  };
}

function formatIssueKey(issue: LspDiagnosticIssue) {
  return [
    issue.filePath,
    issue.line,
    issue.character,
    issue.severity,
    issue.code,
    issue.source ?? "",
    issue.message
  ].join("\0");
}

function cloneCompletedEvent(event: LspDiagnosticCompletedEvent): LspDiagnosticCompletedEvent {
  return {
    ...event,
    issues: event.issues.map((issue) => ({ ...issue }))
  };
}

function clampPositiveInt(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value!));
}

function toCompletedStatus(
  status: LspDiagnosticResultStatus
): LspDiagnosticCompletedStatus | null {
  if (status === "ok" || status === "issues" || status === "failed") {
    return status;
  }

  return null;
}

function truncateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_CHARS);
}
