export type PtySessionStatus = "running" | "exited" | "closed" | "failed";

export interface PtySessionInfo {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: PtySessionStatus;
  pid: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  updatedAt: string;
  exitedAt?: string;
  exitCode?: number;
  signal?: number;
  lastError?: string;
}

export interface PtyCreateOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  title?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
}

export interface PtyReadOptions {
  cursor?: number;
  limit?: number;
  tailLines?: number;
}

export interface PtyReadResult {
  ptyId: string;
  content: string;
  cursor: number;
  nextCursor: number;
  bufferCursor: number;
  bytes: number;
  eof: boolean;
  info: PtySessionInfo;
}

export interface PtyWriteResult {
  ptyId: string;
  bytes: number;
  cursor: number;
  info: PtySessionInfo;
}

export interface PtyResizeResult {
  ptyId: string;
  cols: number;
  rows: number;
  info: PtySessionInfo;
}

export interface PtyCloseResult {
  ptyId: string;
  status: PtySessionStatus | "not_found";
  message: string;
  info?: PtySessionInfo;
}
