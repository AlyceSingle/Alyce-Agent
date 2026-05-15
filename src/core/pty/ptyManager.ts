import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { spawn as spawnPty, type IPty } from "@lydell/node-pty";
import type {
  PtyCloseResult,
  PtyCreateOptions,
  PtyReadOptions,
  PtyReadResult,
  PtyResizeResult,
  PtySessionInfo,
  PtyWriteResult
} from "./ptyTypes.js";

const DEFAULT_BUFFER_LIMIT = 2 * 1024 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface PtyManagerOptions {
  workspaceRoot: string;
  bufferLimit?: number;
}

interface ActivePtySession {
  info: PtySessionInfo;
  process: IPty;
  buffer: string;
  bufferCursor: number;
  cursor: number;
}

export class PtyManager {
  private readonly workspaceRoot: string;
  private readonly bufferLimit: number;
  private readonly sessions = new Map<string, ActivePtySession>();

  constructor(options: PtyManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.bufferLimit = Math.max(1, Math.trunc(options.bufferLimit ?? DEFAULT_BUFFER_LIMIT));
  }

  createSession(options: PtyCreateOptions = {}): PtySessionInfo {
    const id = this.createSessionId();
    const command = options.command?.trim() || getPreferredShell();
    const args = options.args ? [...options.args] : getDefaultShellArgs(command);
    const cwd = this.resolveCwd(options.cwd);
    const cols = normalizeDimension(options.cols, DEFAULT_COLS);
    const rows = normalizeDimension(options.rows, DEFAULT_ROWS);
    const timestamp = nowIso();
    const cwdError = validateExistingDirectory(cwd);
    if (cwdError) {
      return createFailedSessionInfo({
        id,
        createOptions: options,
        command,
        args,
        cwd,
        cols,
        rows,
        timestamp,
        error: cwdError
      });
    }

    let proc: IPty;
    try {
      proc = spawnPty(command, args, {
        name: "xterm-256color",
        cwd,
        env: buildPtyEnv(options.env),
        cols,
        rows
      });
    } catch (error) {
      return createFailedSessionInfo({
        id,
        createOptions: options,
        command,
        args,
        cwd,
        cols,
        rows,
        timestamp,
        error: formatError(error)
      });
    }

    const info: PtySessionInfo = {
      id,
      title: options.title?.trim() || `Terminal ${id.slice(-4)}`,
      command,
      args,
      cwd,
      status: "running",
      pid: normalizePtyPid(proc.pid),
      cols,
      rows,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const session: ActivePtySession = {
      info,
      process: proc,
      buffer: "",
      bufferCursor: 0,
      cursor: 0
    };

    this.sessions.set(id, session);
    proc.onData((chunk) => {
      this.appendOutput(session, chunk);
    });
    proc.onExit((event) => {
      this.handleExit(session, event.exitCode, event.signal);
    });

    return cloneInfo(info);
  }

  listSessions(): PtySessionInfo[] {
    return [...this.sessions.values()].map((session) => cloneInfo(session.info));
  }

  getSession(id: string): PtySessionInfo | undefined {
    const session = this.sessions.get(id);
    return session ? cloneInfo(session.info) : undefined;
  }

  readSession(id: string, options: PtyReadOptions = {}): PtyReadResult {
    const session = this.requireSession(id);
    const end = session.cursor;
    let cursor = options.cursor === -1
      ? end
      : normalizeCursor(options.cursor, session.bufferCursor);
    let content: string;

    if (options.tailLines !== undefined) {
      const tail = sliceTailLines(session.buffer, options.tailLines);
      content = tail.content;
      cursor = session.bufferCursor + tail.startOffset;
    } else {
      cursor = Math.min(Math.max(session.bufferCursor, cursor), end);
      const offset = Math.max(0, cursor - session.bufferCursor);
      const limit = options.limit === undefined
        ? undefined
        : Math.max(0, Math.trunc(options.limit));
      content = limit === undefined
        ? session.buffer.slice(offset)
        : session.buffer.slice(offset, offset + limit);
    }

    const nextCursor = cursor + content.length;
    return {
      ptyId: id,
      content,
      cursor,
      nextCursor,
      bufferCursor: session.bufferCursor,
      bytes: Buffer.byteLength(content, "utf8"),
      eof: nextCursor >= end,
      info: cloneInfo(session.info)
    };
  }

  writeSession(id: string, data: string): PtyWriteResult {
    const session = this.requireRunningSession(id);
    session.process.write(data);
    session.info.updatedAt = nowIso();
    return {
      ptyId: id,
      bytes: Buffer.byteLength(data, "utf8"),
      cursor: session.cursor,
      info: cloneInfo(session.info)
    };
  }

  resizeSession(id: string, cols: number, rows: number): PtyResizeResult {
    const session = this.requireRunningSession(id);
    const normalizedCols = normalizeDimension(cols, DEFAULT_COLS);
    const normalizedRows = normalizeDimension(rows, DEFAULT_ROWS);
    session.process.resize(normalizedCols, normalizedRows);
    session.info.cols = normalizedCols;
    session.info.rows = normalizedRows;
    session.info.updatedAt = nowIso();
    return {
      ptyId: id,
      cols: normalizedCols,
      rows: normalizedRows,
      info: cloneInfo(session.info)
    };
  }

  closeSession(id: string): PtyCloseResult {
    const session = this.sessions.get(id);
    if (!session) {
      return {
        ptyId: id,
        status: "not_found",
        message: `Unknown PTY session: ${id}`
      };
    }

    if (session.info.status === "running") {
      try {
        session.process.kill();
      } catch (error) {
        session.info.lastError = formatError(error);
      }
    }

    session.info.status = "closed";
    session.info.updatedAt = nowIso();
    this.sessions.delete(id);
    return {
      ptyId: id,
      status: "closed",
      message: `PTY session ${id} closed.`,
      info: cloneInfo(session.info)
    };
  }

  closeAll(): PtyCloseResult[] {
    return [...this.sessions.keys()].map((id) => this.closeSession(id));
  }

  private appendOutput(session: ActivePtySession, chunk: string) {
    if (!chunk) {
      return;
    }

    session.buffer += chunk;
    session.cursor += chunk.length;
    if (session.buffer.length > this.bufferLimit) {
      const excess = session.buffer.length - this.bufferLimit;
      session.buffer = session.buffer.slice(excess);
      session.bufferCursor += excess;
    }
    session.info.updatedAt = nowIso();
  }

  private handleExit(
    session: ActivePtySession,
    exitCode: number,
    signal: number | undefined
  ) {
    if (session.info.status !== "running") {
      return;
    }

    session.info.status = "exited";
    session.info.exitCode = exitCode;
    if (signal !== undefined) {
      session.info.signal = signal;
    }
    session.info.exitedAt = nowIso();
    session.info.updatedAt = session.info.exitedAt;
  }

  private requireSession(id: string): ActivePtySession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown PTY session: ${id}`);
    }
    return session;
  }

  private requireRunningSession(id: string): ActivePtySession {
    const session = this.requireSession(id);
    if (session.info.status !== "running") {
      throw new Error(`PTY session ${id} is ${session.info.status}.`);
    }
    return session;
  }

  private resolveCwd(cwd: string | undefined): string {
    const normalized = cwd?.trim();
    if (!normalized) {
      return this.workspaceRoot;
    }
    return path.resolve(this.workspaceRoot, normalized);
  }

  private createSessionId(): string {
    let id = "";
    do {
      id = `pty_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    } while (this.sessions.has(id));
    return id;
  }
}

export function getPreferredShell(): string {
  if (process.platform !== "win32") {
    return process.env.SHELL || (fsSync.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh");
  }

  const pwsh = findExecutableOnPath("pwsh.exe");
  if (pwsh) {
    return pwsh;
  }

  const powershell = findExecutableOnPath("powershell.exe");
  if (powershell) {
    return powershell;
  }

  return process.env.COMSPEC || "cmd.exe";
}

function getDefaultShellArgs(command: string): string[] {
  const name = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && new Set(["bash", "dash", "ksh", "sh", "zsh"]).has(name)) {
    return ["-l"];
  }

  return [];
}

function buildPtyEnv(env: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = {
    ...process.env,
    ...(env ?? {}),
    TERM: "xterm-256color",
    ALYCE_TERMINAL: "1"
  };

  if (process.platform === "win32") {
    next.LC_ALL = "C.UTF-8";
    next.LC_CTYPE = "C.UTF-8";
    next.LANG = "C.UTF-8";
  }

  return next;
}

function findExecutableOnPath(executable: string): string | undefined {
  const pathValue = process.env.PATH || "";
  const separator = process.platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(separator)) {
    if (!directory) {
      continue;
    }

    const candidate = path.join(directory, executable);
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function sliceTailLines(text: string, lineCount: number): { content: string; startOffset: number } {
  const normalizedCount = Math.max(0, Math.trunc(lineCount));
  if (normalizedCount === 0 || text.length === 0) {
    return {
      content: "",
      startOffset: text.length
    };
  }

  const scanEnd = text.endsWith("\n") ? text.length - 1 : text.length;
  let seenLineBreaks = 0;
  for (let index = scanEnd - 1; index >= 0; index -= 1) {
    if (text[index] !== "\n") {
      continue;
    }

    seenLineBreaks += 1;
    if (seenLineBreaks === normalizedCount) {
      const startOffset = index + 1;
      return {
        content: text.slice(startOffset),
        startOffset
      };
    }
  }

  return {
    content: text,
    startOffset: 0
  };
}

function validateExistingDirectory(directory: string): string | undefined {
  try {
    const stats = fsSync.statSync(directory);
    return stats.isDirectory()
      ? undefined
      : `Working directory is not a directory: ${directory}`;
  } catch (error) {
    if (isNotFoundError(error)) {
      return `Working directory does not exist: ${directory}`;
    }

    return formatError(error);
  }
}

function createFailedSessionInfo(options: {
  id: string;
  createOptions: PtyCreateOptions;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  timestamp: string;
  error: string;
}): PtySessionInfo {
  return {
    id: options.id,
    title: options.createOptions.title?.trim() || `Terminal ${options.id.slice(-4)}`,
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    status: "failed",
    pid: null,
    cols: options.cols,
    rows: options.rows,
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
    lastError: options.error
  };
}

function normalizePtyPid(pid: number | undefined): number | null {
  return pid && pid > 0 ? pid : null;
}

function normalizeCursor(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function cloneInfo(info: PtySessionInfo): PtySessionInfo {
  return {
    ...info,
    args: [...info.args]
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
