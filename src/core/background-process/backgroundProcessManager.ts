import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { wrapPowerShellCommand } from "../../tools/internal/commandOutput.js";
import { resolveSimplePackageManagerFastPath } from "../../tools/internal/packageManagerFastPath.js";
import { shouldSpawnDetachedProcessGroup, terminateProcessTree } from "../../tools/internal/processTree.js";
import { resolveWindowsNativeCommandInvocation } from "../../tools/internal/windowsNativeCommand.js";
import { LogBuffer } from "./logBuffer.js";
import { detectDevServerReadiness, detectPortConflicts, detectPorts, detectUrls } from "./portDetector.js";
import type {
  BackgroundProcessReadOptions,
  BackgroundProcessReadResult,
  BackgroundProcessRecord,
  BackgroundProcessStartOptions,
  BackgroundProcessStatus,
  BackgroundProcessStopOptions,
  BackgroundProcessStopResult
} from "./backgroundProcessTypes.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const DEFAULT_PREVIEW_BYTES = 64 * 1024;

export interface BackgroundProcessManagerOptions {
  workspaceRoot: string;
  storageRoot?: string;
  defaultStartupTimeoutMs?: number;
  previewBytes?: number;
}

export interface BackgroundProcessListOptions {
  includeExited?: boolean;
}

export interface BackgroundCommandInvocation {
  executable: string;
  args: string[];
  shell: false;
  windowsHide: boolean;
  windowsVerbatimArguments?: boolean;
  mode: "native-argv" | "shell-wrapper";
}

interface BackgroundCommandInvocationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
}

interface ManagedBackgroundProcess {
  record: BackgroundProcessRecord;
  child: ChildProcess;
  stdoutBuffer: LogBuffer;
  stderrBuffer: LogBuffer;
  combinedBuffer: LogBuffer;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  waitFor: string[];
  startupTimer: NodeJS.Timeout | null;
  startupSettled: boolean;
  stopRequested: boolean;
  resolveStartup: (record: BackgroundProcessRecord) => void;
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

export class BackgroundProcessManager {
  private readonly workspaceRoot: string;
  private readonly storageRoot: string;
  private readonly defaultStartupTimeoutMs: number;
  private readonly previewBytes: number;
  private readonly processes = new Map<string, ManagedBackgroundProcess>();

  constructor(options: BackgroundProcessManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.storageRoot = path.resolve(
      options.storageRoot ?? path.join(this.workspaceRoot, ".alyce", "background-processes")
    );
    this.defaultStartupTimeoutMs = normalizePositiveInteger(
      options.defaultStartupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS
    );
    this.previewBytes = normalizePositiveInteger(options.previewBytes, DEFAULT_PREVIEW_BYTES);
  }

  async startProcess(options: BackgroundProcessStartOptions): Promise<BackgroundProcessRecord> {
    const command = options.command.trim();
    if (!command) {
      throw new Error("Background process command must not be empty.");
    }

    const id = this.createProcessId();
    const cwd = this.resolveCwd(options.cwd);
    const processDirectory = path.join(this.storageRoot, id);
    const record = this.createInitialRecord({
      id,
      command,
      cwd,
      label: options.label,
      processDirectory
    });
    const cwdError = await validateExistingDirectory(cwd);
    if (cwdError) {
      record.status = "failed";
      record.lastError = cwdError;
      record.updatedAt = nowIso();
      return cloneRecord(record);
    }

    await fs.mkdir(processDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(record.stdoutLogPath, ""),
      fs.writeFile(record.stderrLogPath, ""),
      fs.writeFile(record.combinedLogPath, ""),
      this.writeProcessRecord(record)
    ]);

    const invocation = resolveBackgroundCommandInvocation(command);
    let child: ChildProcess;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd,
        env: mergeProcessEnv(options.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: shouldSpawnDetachedProcessGroup(),
        windowsHide: invocation.windowsHide,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        shell: invocation.shell
      });
    } catch (error) {
      record.status = "failed";
      record.lastError = formatError(error);
      record.updatedAt = nowIso();
      await this.writeProcessRecord(record);
      return cloneRecord(record);
    }

    record.pid = child.pid ?? null;
    record.updatedAt = nowIso();
    await this.writeProcessRecord(record);

    let resolveStartup: (record: BackgroundProcessRecord) => void = () => undefined;
    let resolveExit: () => void = () => undefined;
    const startupPromise = new Promise<BackgroundProcessRecord>((resolve) => {
      resolveStartup = resolve;
    });
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const entry: ManagedBackgroundProcess = {
      record,
      child,
      stdoutBuffer: new LogBuffer({ maxBytes: this.previewBytes }),
      stderrBuffer: new LogBuffer({ maxBytes: this.previewBytes }),
      combinedBuffer: new LogBuffer({ maxBytes: this.previewBytes }),
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      waitFor: options.waitFor?.filter((value) => value.length > 0) ?? [],
      startupTimer: null,
      startupSettled: false,
      stopRequested: false,
      resolveStartup,
      exitPromise,
      resolveExit
    };

    this.processes.set(id, entry);
    this.attachProcessListeners(entry);
    this.startStartupTimer(entry, options.startupTimeoutMs);

    return startupPromise;
  }

  listProcesses(options: BackgroundProcessListOptions = {}): BackgroundProcessRecord[] {
    const includeExited = options.includeExited === true;
    return [...this.processes.values()]
      .map((entry) => entry.record)
      .filter((record) => includeExited || !isTerminalStatus(record.status))
      .map(cloneRecord);
  }

  getProcess(processId: string): BackgroundProcessRecord | undefined {
    const record = this.processes.get(processId)?.record;
    return record ? cloneRecord(record) : undefined;
  }

  async readProcessLog(
    processId: string,
    options: BackgroundProcessReadOptions = {}
  ): Promise<BackgroundProcessReadResult> {
    const record = this.processes.get(processId)?.record ?? await this.readProcessRecord(processId);
    if (!record) {
      throw new Error(`Unknown background process: ${processId}`);
    }

    const stream = options.stream ?? "combined";
    const logPath = getLogPath(record, stream);
    const fullBuffer = await readFileBufferIfExists(logPath);
    const requestedTailLines = options.tailLines;
    let offset = Math.max(0, Math.trunc(options.offset ?? 0));
    let content: string;

    if (requestedTailLines !== undefined) {
      const tail = sliceTailLineBuffer(fullBuffer, requestedTailLines);
      content = tail.buffer.toString("utf8");
      offset = tail.offset;
    } else {
      const limit = options.limit === undefined
        ? undefined
        : Math.max(0, Math.trunc(options.limit));
      const slice = limit === undefined
        ? fullBuffer.subarray(offset)
        : fullBuffer.subarray(offset, offset + limit);
      content = slice.toString("utf8");
    }

    return {
      processId,
      stream,
      logPath,
      content,
      offset,
      bytes: Buffer.byteLength(content, "utf8"),
      eof: offset + Buffer.byteLength(content, "utf8") >= fullBuffer.length
    };
  }

  async stopProcess(
    processId: string,
    options: BackgroundProcessStopOptions = {}
  ): Promise<BackgroundProcessStopResult> {
    const entry = this.processes.get(processId);
    if (!entry) {
      return {
        processId,
        status: "not_found",
        message: `Unknown background process: ${processId}`
      };
    }

    if (isTerminalStatus(entry.record.status)) {
      return {
        processId,
        status: entry.record.status,
        exitCode: entry.record.exitCode,
        signal: entry.record.signal,
        message: `Background process is already ${entry.record.status}.`,
        record: cloneRecord(entry.record)
      };
    }

    entry.stopRequested = true;
    terminateProcessTree(entry.child, options.force ? "SIGKILL" : "SIGTERM");

    const gracefulTimeoutMs = normalizePositiveInteger(
      options.gracefulTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS
    );
    let exited = await waitForPromise(entry.exitPromise, gracefulTimeoutMs);
    if (!exited && options.force !== true) {
      terminateProcessTree(entry.child, "SIGKILL");
      exited = await waitForPromise(entry.exitPromise, 1_000);
    }

    if (!exited) {
      entry.record.lastError = "Stop requested, but the process did not exit before timeout.";
      entry.record.updatedAt = nowIso();
      await this.writeProcessRecord(entry.record);
    }

    return {
      processId,
      status: entry.record.status,
      exitCode: entry.record.exitCode,
      signal: entry.record.signal,
      message: exited
        ? `Background process ${processId} stopped.`
        : `Stop requested for background process ${processId}, but it is still running.`,
      record: cloneRecord(entry.record)
    };
  }

  async stopAll(options: BackgroundProcessStopOptions = {}): Promise<BackgroundProcessStopResult[]> {
    const running = [...this.processes.values()]
      .filter((entry) => !isTerminalStatus(entry.record.status))
      .map((entry) => entry.record.id);
    return Promise.all(running.map((processId) => this.stopProcess(processId, options)));
  }

  private createInitialRecord(options: {
    id: string;
    command: string;
    cwd: string;
    label?: string;
    processDirectory: string;
  }): BackgroundProcessRecord {
    const timestamp = nowIso();
    return {
      id: options.id,
      command: options.command,
      cwd: options.cwd,
      label: options.label,
      pid: null,
      status: "starting",
      startedAt: timestamp,
      updatedAt: timestamp,
      stdoutLogPath: path.join(options.processDirectory, "stdout.log"),
      stderrLogPath: path.join(options.processDirectory, "stderr.log"),
      combinedLogPath: path.join(options.processDirectory, "output.log"),
      recordPath: path.join(options.processDirectory, "process.json"),
      stdoutPreview: "",
      stderrPreview: "",
      detectedUrls: [],
      detectedPorts: [],
      warnings: []
    };
  }

  private attachProcessListeners(entry: ManagedBackgroundProcess) {
    entry.child.stdout?.on("data", (chunk: Buffer | string) => {
      this.handleOutput(entry, "stdout", chunk);
    });
    entry.child.stderr?.on("data", (chunk: Buffer | string) => {
      this.handleOutput(entry, "stderr", chunk);
    });
    entry.child.stdout?.on("end", () => {
      this.flushDecoder(entry, "stdout");
    });
    entry.child.stderr?.on("end", () => {
      this.flushDecoder(entry, "stderr");
    });
    entry.child.on("error", (error) => {
      this.markFailed(entry, formatError(error));
    });
    entry.child.on("close", (exitCode, signal) => {
      this.handleClose(entry, exitCode, signal);
    });
  }

  private startStartupTimer(
    entry: ManagedBackgroundProcess,
    requestedTimeoutMs: number | undefined
  ) {
    const timeoutMs = normalizePositiveInteger(requestedTimeoutMs, this.defaultStartupTimeoutMs);
    entry.startupTimer = setTimeout(() => {
      if (entry.record.status === "starting") {
        entry.record.startupTimedOut = true;
        this.markRunning(entry);
      }
    }, timeoutMs);
    entry.startupTimer.unref?.();
  }

  private handleOutput(
    entry: ManagedBackgroundProcess,
    stream: "stdout" | "stderr",
    chunk: Buffer | string
  ) {
    const raw = toBuffer(chunk);
    const decoded = stream === "stdout"
      ? entry.stdoutDecoder.write(raw)
      : entry.stderrDecoder.write(raw);

    try {
      this.appendRawLog(entry.record, stream, raw);
    } catch (error) {
      entry.record.lastError = formatError(error);
      entry.record.updatedAt = nowIso();
      this.writeProcessRecordBestEffort(entry.record);
    }
    this.appendDecodedOutput(entry, stream, decoded);
  }

  private flushDecoder(entry: ManagedBackgroundProcess, stream: "stdout" | "stderr") {
    const decoded = stream === "stdout"
      ? entry.stdoutDecoder.end()
      : entry.stderrDecoder.end();
    this.appendDecodedOutput(entry, stream, decoded);
  }

  private appendRawLog(
    record: BackgroundProcessRecord,
    stream: "stdout" | "stderr",
    chunk: Buffer
  ) {
    if (chunk.length === 0) {
      return;
    }

    fsSync.appendFileSync(stream === "stdout" ? record.stdoutLogPath : record.stderrLogPath, chunk);
    fsSync.appendFileSync(record.combinedLogPath, chunk);
  }

  private appendDecodedOutput(
    entry: ManagedBackgroundProcess,
    stream: "stdout" | "stderr",
    decoded: string
  ) {
    if (!decoded) {
      return;
    }

    if (stream === "stdout") {
      entry.record.stdoutPreview = entry.stdoutBuffer.append(decoded);
    } else {
      entry.record.stderrPreview = entry.stderrBuffer.append(decoded);
    }

    entry.combinedBuffer.append(decoded);
    this.updateDetectedEndpoints(entry);
    entry.record.updatedAt = nowIso();
    this.writeProcessRecordBestEffort(entry.record);
  }

  private updateDetectedEndpoints(entry: ManagedBackgroundProcess) {
    const output = entry.combinedBuffer.getText();
    const portConflicts = detectPortConflicts(output);
    entry.record.detectedUrls = unique([
      ...entry.record.detectedUrls,
      ...detectUrls(output)
    ]);
    entry.record.detectedPorts = unique([
      ...entry.record.detectedPorts,
      ...detectPorts(output),
      ...portConflicts.flatMap((conflict) => conflict.ports)
    ]).sort((left, right) => left - right);
    entry.record.warnings = unique([
      ...entry.record.warnings,
      ...portConflicts.map((conflict) => conflict.message)
    ]);

    if (entry.record.status !== "starting") {
      return;
    }

    const startupMatched = entry.waitFor.find((needle) => output.includes(needle));
    if (startupMatched) {
      this.markRunning(entry, startupMatched);
      return;
    }

    const readySignal = detectDevServerReadiness(output);
    if (readySignal) {
      this.markRunning(entry, readySignal);
      return;
    }

    if (
      entry.record.detectedUrls.length > 0 &&
      (portConflicts.length === 0 || hasDevServerUrlLine(output))
    ) {
      this.markRunning(entry);
    }
  }

  private markRunning(entry: ManagedBackgroundProcess, startupMatched?: string) {
    if (entry.record.status !== "starting") {
      return;
    }

    entry.record.status = "running";
    entry.record.startupMatched = startupMatched ?? entry.record.startupMatched;
    entry.record.updatedAt = nowIso();
    this.writeProcessRecordBestEffort(entry.record);
    this.resolveStartup(entry);
  }

  private markFailed(entry: ManagedBackgroundProcess, error: string) {
    if (isTerminalStatus(entry.record.status)) {
      return;
    }

    entry.record.status = "failed";
    entry.record.lastError = error;
    entry.record.updatedAt = nowIso();
    this.writeProcessRecordBestEffort(entry.record);
    this.resolveStartup(entry);
  }

  private handleClose(
    entry: ManagedBackgroundProcess,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ) {
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
      entry.startupTimer = null;
    }

    const terminalStatus = this.getCloseStatus(entry, exitCode);
    entry.record.status = terminalStatus;
    entry.record.exitCode = exitCode;
    entry.record.signal = signal;
    entry.record.exitedAt = nowIso();
    entry.record.updatedAt = entry.record.exitedAt;
    if (terminalStatus === "failed" && !entry.record.lastError && entry.record.warnings.length > 0) {
      entry.record.lastError = entry.record.warnings[0];
    }
    this.writeProcessRecordBestEffort(entry.record);
    this.resolveStartup(entry);
    entry.resolveExit();
  }

  private getCloseStatus(
    entry: ManagedBackgroundProcess,
    exitCode: number | null
  ): BackgroundProcessStatus {
    if (entry.stopRequested) {
      return "stopped";
    }

    if (entry.record.status === "failed") {
      return "failed";
    }

    if (entry.record.status === "starting" && exitCode !== 0) {
      return "failed";
    }

    return "exited";
  }

  private resolveStartup(entry: ManagedBackgroundProcess) {
    if (entry.startupSettled) {
      return;
    }

    entry.startupSettled = true;
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
      entry.startupTimer = null;
    }
    entry.resolveStartup(cloneRecord(entry.record));
  }

  private resolveCwd(cwd: string | undefined): string {
    const normalized = cwd?.trim();
    if (!normalized) {
      return this.workspaceRoot;
    }

    return path.resolve(this.workspaceRoot, normalized);
  }

  private createProcessId(): string {
    let id = "";
    do {
      id = `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    } while (this.processes.has(id));
    return id;
  }

  private async writeProcessRecord(record: BackgroundProcessRecord) {
    await fs.writeFile(record.recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  private writeProcessRecordBestEffort(record: BackgroundProcessRecord) {
    void this.writeProcessRecord(record).catch(() => undefined);
  }

  private async readProcessRecord(processId: string): Promise<BackgroundProcessRecord | null> {
    const recordPath = path.join(this.storageRoot, processId, "process.json");
    try {
      return JSON.parse(await fs.readFile(recordPath, "utf8")) as BackgroundProcessRecord;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }
}

export function resolveBackgroundCommandInvocation(
  command: string,
  options: BackgroundCommandInvocationOptions = {}
): BackgroundCommandInvocation {
  const platform = options.platform ?? process.platform;
  const fastPathArgv = resolveSimplePackageManagerFastPath(command, platform);
  if (fastPathArgv) {
    const invocation = resolveWindowsNativeCommandInvocation(fastPathArgv, {
      platform,
      env: options.env,
      existsSync: options.existsSync
    });
    return {
      executable: invocation.command,
      args: invocation.args,
      shell: false,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      mode: "native-argv"
    };
  }

  if (platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoProfile", "-Command", wrapPowerShellCommand(command)],
      shell: false,
      windowsHide: true,
      mode: "shell-wrapper"
    };
  }

  return {
    executable: process.env.SHELL || "/bin/bash",
    args: ["-lc", command],
    shell: false,
    windowsHide: true,
    mode: "shell-wrapper"
  };
}

function getLogPath(
  record: BackgroundProcessRecord,
  stream: "stdout" | "stderr" | "combined"
): string {
  if (stream === "stdout") {
    return record.stdoutLogPath;
  }
  if (stream === "stderr") {
    return record.stderrLogPath;
  }
  return record.combinedLogPath;
}

function mergeProcessEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(env ?? {})
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

function isTerminalStatus(status: BackgroundProcessStatus): boolean {
  return status === "exited" || status === "failed" || status === "stopped";
}

function cloneRecord(record: BackgroundProcessRecord): BackgroundProcessRecord {
  return {
    ...record,
    detectedUrls: [...record.detectedUrls],
    detectedPorts: [...record.detectedPorts],
    warnings: [...record.warnings]
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      }
    );
  });
}

function hasDevServerUrlLine(output: string): boolean {
  return /\b(?:local|network|ready|server|running|listening)\b.{0,120}\bhttps?:\/\//iu.test(output);
}

async function readFileBufferIfExists(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return Buffer.alloc(0);
    }
    throw error;
  }
}

function sliceTailLineBuffer(buffer: Buffer, lineCount: number): { buffer: Buffer; offset: number } {
  const normalizedCount = Math.max(0, Math.trunc(lineCount));
  if (normalizedCount === 0 || buffer.length === 0) {
    return {
      buffer: Buffer.alloc(0),
      offset: buffer.length
    };
  }

  const scanEnd = buffer[buffer.length - 1] === 0x0a ? buffer.length - 1 : buffer.length;
  let seenLineBreaks = 0;
  for (let index = scanEnd - 1; index >= 0; index -= 1) {
    if (buffer[index] !== 0x0a) {
      continue;
    }

    seenLineBreaks += 1;
    if (seenLineBreaks === normalizedCount) {
      const offset = index + 1;
      return {
        buffer: buffer.subarray(offset),
        offset
      };
    }
  }

  return {
    buffer,
    offset: 0
  };
}

async function validateExistingDirectory(directory: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(directory);
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

function isNotFoundError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
