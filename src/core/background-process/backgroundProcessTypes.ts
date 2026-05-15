export type BackgroundProcessStatus =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "stopped";

export type BackgroundProcessLogStream = "stdout" | "stderr" | "combined";

export interface BackgroundProcessRecord {
  id: string;
  command: string;
  cwd: string;
  label?: string;
  pid: number | null;
  status: BackgroundProcessStatus;
  startedAt: string;
  updatedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stdoutLogPath: string;
  stderrLogPath: string;
  combinedLogPath: string;
  recordPath: string;
  stdoutPreview: string;
  stderrPreview: string;
  detectedUrls: string[];
  detectedPorts: number[];
  warnings: string[];
  startupMatched?: string;
  startupTimedOut?: boolean;
  lastError?: string;
}

export interface BackgroundProcessStartOptions {
  command: string;
  cwd?: string;
  startupTimeoutMs?: number;
  waitFor?: string[];
  env?: Record<string, string | undefined>;
  label?: string;
}

export interface BackgroundProcessReadOptions {
  stream?: BackgroundProcessLogStream;
  tailLines?: number;
  offset?: number;
  limit?: number;
}

export interface BackgroundProcessReadResult {
  processId: string;
  stream: BackgroundProcessLogStream;
  logPath: string;
  content: string;
  offset: number;
  bytes: number;
  eof: boolean;
}

export interface BackgroundProcessStopOptions {
  force?: boolean;
  gracefulTimeoutMs?: number;
}

export interface BackgroundProcessStopResult {
  processId: string;
  status: BackgroundProcessStatus | "not_found";
  exitCode?: number | null;
  signal?: string | null;
  message: string;
  record?: BackgroundProcessRecord;
}
