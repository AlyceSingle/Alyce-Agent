import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { throwIfAborted } from "../../core/abort.js";
import { registerPendingPostWriteDiagnostics } from "../../services/lsp/LspDiagnosticRegistry.js";
import {
  syncLspRuntimeFileChange,
  syncLspRuntimeFileSave
} from "../../services/lsp/LspRuntimeService.js";
import {
  getTypeScriptDiagnosticsForFileAsync,
  isTypeScriptDiagnosticSupported,
  type TypeScriptDiagnosticIssue
} from "./typeScriptDiagnostics.js";
import { runNativeCommandWithTimeout } from "./nativeCommandRunner.js";

const FORMATTER_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT_CHARS = 4_000;
const DIAGNOSTICS_INLINE_BUDGET_MS = 300;
const MAX_OBSERVATION_ERROR_CHARS = 300;

const PRETTIER_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".md",
  ".mdx",
  ".graphql",
  ".gql"
]);

const BIOME_EXTENSIONS = PRETTIER_EXTENSIONS;

export type PostWriteFormatterStatus = "skipped" | "unchanged" | "formatted" | "failed";
export type PostWriteDiagnosticsStatus = "skipped" | "pending" | "ok" | "issues" | "failed";

export interface PostWriteFormatterResult {
  status: PostWriteFormatterStatus;
  formatter?: string;
  command?: string[];
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export interface PostWriteDiagnosticsResult {
  status: PostWriteDiagnosticsStatus;
  backend?: "typescript-language-service";
  issues: TypeScriptDiagnosticIssue[];
  totalIssueCount: number;
  truncated: boolean;
  message?: string;
}

export interface PostWriteChecksResult {
  formatter: PostWriteFormatterResult;
  diagnostics: PostWriteDiagnosticsResult;
}

export interface PostWriteDiagnosticsObservation {
  filePath: string;
  returnedStatus: PostWriteDiagnosticsStatus;
  returnedPending: boolean;
  inlineDurationMs: number;
  timestamp: string;
  finalStatus?: PostWriteDiagnosticsStatus;
  finalDurationMs?: number;
  finalIssueCount?: number;
  finalTimestamp?: string;
  finalMessage?: string;
}

export interface PostWriteDiagnosticsObservationStatsSnapshot {
  totalRuns: number;
  inlineCompletions: number;
  pendingReturns: number;
  backgroundCompletions: number;
  returnedStatusCounts: Record<PostWriteDiagnosticsStatus, number>;
  finalStatusCounts: Record<PostWriteDiagnosticsStatus, number>;
  lastObservation: PostWriteDiagnosticsObservation | null;
}

type PostWriteDiagnosticsObservationStats = {
  totalRuns: number;
  inlineCompletions: number;
  pendingReturns: number;
  backgroundCompletions: number;
  returnedStatusCounts: Record<PostWriteDiagnosticsStatus, number>;
  finalStatusCounts: Record<PostWriteDiagnosticsStatus, number>;
  lastObservation: PostWriteDiagnosticsObservation | null;
};

const postWriteDiagnosticsObservationStats = createEmptyPostWriteDiagnosticsObservationStats();

export const __POST_WRITE_CHECKS_TESTING__ = {
  resolveDiagnosticsForToolResponse,
  getPostWriteDiagnosticsObservationStatsSnapshot,
  resetPostWriteDiagnosticsObservationStats
};

type FormatterCommand = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

type CommandResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function runPostWriteChecks(options: {
  absolutePath: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  abortSignal?: AbortSignal;
}): Promise<PostWriteChecksResult> {
  const formatter = await runFormatter(options);
  throwIfAborted(options.abortSignal);
  await syncFileWithLspRuntime(options);

  const diagnosticsStartedAtMs = Date.now();
  const diagnosticsPromise = runDiagnostics(options);
  const diagnostics = await resolveDiagnosticsForToolResponse({
    diagnosticsPromise,
    absolutePath: options.absolutePath,
    workspaceRoot: options.workspaceRoot,
    startedAtMs: diagnosticsStartedAtMs
  });
  return { formatter, diagnostics };
}

async function syncFileWithLspRuntime(options: {
  absolutePath: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  abortSignal?: AbortSignal;
}) {
  try {
    await syncLspRuntimeFileChange({
      filePath: options.absolutePath,
      workspaceRoot: options.workspaceRoot,
      allowedRoots: options.allowedRoots,
      abortSignal: options.abortSignal
    });
    await syncLspRuntimeFileSave({
      filePath: options.absolutePath,
      workspaceRoot: options.workspaceRoot,
      allowedRoots: options.allowedRoots,
      abortSignal: options.abortSignal
    });
  } catch {
    // Post-write checks should keep running even if runtime sync fails.
  }
}

async function runFormatter(options: {
  absolutePath: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  abortSignal?: AbortSignal;
}): Promise<PostWriteFormatterResult> {
  const projectRoot = resolveProjectRoot(
    options.absolutePath,
    options.workspaceRoot,
    options.allowedRoots
  );
  const formatter = await resolveFormatter(options.absolutePath, projectRoot);
  if (!formatter) {
    return {
      status: "skipped",
      message: "No configured formatter found for this file type."
    };
  }

  let before: Buffer;
  try {
    before = await fs.readFile(options.absolutePath);
  } catch (error) {
    return {
      status: "failed",
      formatter: formatter.name,
      command: [formatter.command, ...formatter.args],
      message: formatError(error)
    };
  }

  throwIfAborted(options.abortSignal);
  const result = await runCommand(formatter, options.abortSignal);
  if (result.exitCode !== 0) {
    return {
      status: "failed",
      formatter: formatter.name,
      command: [formatter.command, ...formatter.args],
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      message: result.timedOut ? "Formatter timed out." : "Formatter exited with a non-zero status."
    };
  }

  let after: Buffer;
  try {
    after = await fs.readFile(options.absolutePath);
  } catch (error) {
    return {
      status: "failed",
      formatter: formatter.name,
      command: [formatter.command, ...formatter.args],
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      message: formatError(error)
    };
  }

  return {
    status: before.equals(after) ? "unchanged" : "formatted",
    formatter: formatter.name,
    command: [formatter.command, ...formatter.args],
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout || undefined,
    stderr: result.stderr || undefined
  };
}

async function runDiagnostics(options: {
  absolutePath: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  abortSignal?: AbortSignal;
}): Promise<PostWriteDiagnosticsResult> {
  if (!isTypeScriptDiagnosticSupported(options.absolutePath)) {
    return {
      status: "skipped",
      issues: [],
      totalIssueCount: 0,
      truncated: false,
      message: "Diagnostics currently support TypeScript/JavaScript files only."
    };
  }

  try {
    throwIfAborted(options.abortSignal);
    const result = await getTypeScriptDiagnosticsForFileAsync({
      fileName: options.absolutePath,
      workspaceRoot: options.workspaceRoot,
      allowedRoots: options.allowedRoots,
      abortSignal: options.abortSignal
    });
    return {
      status: result.issues.length > 0 ? "issues" : "ok",
      backend: result.backend,
      issues: result.issues,
      totalIssueCount: result.totalIssueCount,
      truncated: result.truncated
    };
  } catch (error) {
    return {
      status: "failed",
      backend: "typescript-language-service",
      issues: [],
      totalIssueCount: 0,
      truncated: false,
      message: formatError(error)
    };
  }
}

async function resolveDiagnosticsForToolResponse(options: {
  diagnosticsPromise: Promise<PostWriteDiagnosticsResult>;
  absolutePath: string;
  workspaceRoot: string;
  startedAtMs: number;
  inlineBudgetMs?: number;
}): Promise<PostWriteDiagnosticsResult> {
  let timeout: NodeJS.Timeout | undefined;
  const inlineBudgetMs = Math.max(1, Math.trunc(options.inlineBudgetMs ?? DIAGNOSTICS_INLINE_BUDGET_MS));
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), inlineBudgetMs);
  });

  const raced = await Promise.race([
    options.diagnosticsPromise.then((result) => ({ kind: "result" as const, result })),
    timeoutPromise.then(() => ({ kind: "timeout" as const }))
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }

  if (raced.kind === "result") {
    recordReturnedDiagnosticsObservation({
      filePath: formatObservationPath(options.workspaceRoot, options.absolutePath),
      returnedStatus: raced.result.status,
      returnedPending: false,
      inlineDurationMs: Date.now() - options.startedAtMs
    });
    return raced.result;
  }

  const filePath = formatObservationPath(options.workspaceRoot, options.absolutePath);
  recordReturnedDiagnosticsObservation({
    filePath,
    returnedStatus: "pending",
    returnedPending: true,
    inlineDurationMs: Date.now() - options.startedAtMs
  });
  registerPendingPostWriteDiagnostics({
    filePath,
    backend: "typescript-language-service",
    startedAtMs: options.startedAtMs,
    diagnosticsPromise: options.diagnosticsPromise
  });

  void options.diagnosticsPromise.then((result) => {
    recordFinalDiagnosticsObservation({
      filePath,
      finalStatus: result.status,
      finalDurationMs: Date.now() - options.startedAtMs,
      finalIssueCount: result.totalIssueCount,
      finalMessage: result.message
    });
  }).catch((error) => {
    recordFinalDiagnosticsObservation({
      filePath,
      finalStatus: "failed",
      finalDurationMs: Date.now() - options.startedAtMs,
      finalIssueCount: 0,
      finalMessage: truncateObservationError(error)
    });
  });

  return {
    status: "pending",
    backend: "typescript-language-service",
    issues: [],
    totalIssueCount: 0,
    truncated: false,
    message: "Diagnostics are running in the background."
  };
}

async function resolveFormatter(
  absolutePath: string,
  projectRoot: string
): Promise<FormatterCommand | null> {
  const extension = path.extname(absolutePath).toLowerCase();
  const startDir = path.dirname(absolutePath);

  if (BIOME_EXTENSIONS.has(extension) && (await findUpAny(["biome.json", "biome.jsonc"], startDir, projectRoot))) {
    const biome = await findLocalNodeBin("biome", startDir, projectRoot);
    if (biome) {
      return {
        name: "biome",
        command: biome,
        args: ["format", "--write", absolutePath],
        cwd: projectRoot
      };
    }
  }

  if (PRETTIER_EXTENSIONS.has(extension) && (await shouldUsePrettier(startDir, projectRoot))) {
    const prettier = await findLocalNodeBin("prettier", startDir, projectRoot);
    if (prettier) {
      return {
        name: "prettier",
        command: prettier,
        args: ["--write", absolutePath],
        cwd: projectRoot,
        env: { ...process.env, BUN_BE_BUN: "1" }
      };
    }
  }

  if (extension === ".go") {
    return resolvePathFormatter("gofmt", ["-w", absolutePath], projectRoot);
  }

  if (extension === ".rs") {
    return resolvePathFormatter("rustfmt", [absolutePath], projectRoot);
  }

  if (extension === ".zig" || extension === ".zon") {
    return resolvePathFormatter("zig", ["fmt", absolutePath], projectRoot);
  }

  if (extension === ".sh" || extension === ".bash") {
    return resolvePathFormatter("shfmt", ["-w", absolutePath], projectRoot);
  }

  if ((extension === ".py" || extension === ".pyi") && (await shouldUseRuff(startDir, projectRoot))) {
    return resolvePathFormatter("ruff", ["format", absolutePath], projectRoot);
  }

  if (isClangFormatExtension(extension) && (await findUpFile(".clang-format", startDir, projectRoot))) {
    return resolvePathFormatter("clang-format", ["-i", absolutePath], projectRoot);
  }

  if (extension === ".tf" || extension === ".tfvars") {
    return resolvePathFormatter("terraform", ["fmt", absolutePath], projectRoot);
  }

  if (extension === ".dart") {
    return resolvePathFormatter("dart", ["format", absolutePath], projectRoot);
  }

  return null;
}

async function shouldUsePrettier(startDir: string, projectRoot: string) {
  if (await packageDeclaresDependency(startDir, projectRoot, ["prettier"])) {
    return true;
  }

  return Boolean(
    await findUpAny(
      [
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.yml",
        ".prettierrc.yaml",
        ".prettierrc.json5",
        ".prettierrc.js",
        ".prettierrc.cjs",
        ".prettierrc.mjs",
        "prettier.config.js",
        "prettier.config.cjs",
        "prettier.config.mjs"
      ],
      startDir,
      projectRoot
    )
  );
}

async function shouldUseRuff(startDir: string, projectRoot: string) {
  const ruffConfig = await findUpAny(["ruff.toml", ".ruff.toml"], startDir, projectRoot);
  if (ruffConfig) {
    return true;
  }

  const pyproject = await findUpFile("pyproject.toml", startDir, projectRoot);
  if (pyproject) {
    const content = await readTextIfExists(pyproject);
    if (content?.includes("[tool.ruff]")) {
      return true;
    }
  }

  return packageDeclaresDependency(startDir, projectRoot, ["ruff"]);
}

async function resolvePathFormatter(
  name: string,
  args: string[],
  cwd: string
): Promise<FormatterCommand | null> {
  const command = await findOnPath(name);
  return command ? { name, command, args, cwd } : null;
}

async function runCommand(formatter: FormatterCommand, abortSignal?: AbortSignal): Promise<CommandResult> {
  const result = await runNativeCommandWithTimeout([formatter.command, ...formatter.args], {
    cwd: formatter.cwd,
    env: formatter.env ?? process.env,
    timeoutMs: FORMATTER_TIMEOUT_MS,
    abortSignal,
    maxOutputBytes: MAX_PROCESS_OUTPUT_CHARS + 1
  });
  const stderr =
    result.error && result.error !== "timeout" && result.error !== "aborted"
      ? appendProcessOutput(result.stderr, result.error)
      : result.stderr;

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: truncateProcessOutput(result.stdout),
    stderr: truncateProcessOutput(stderr),
    durationMs: result.durationMs
  };
}

function resolveProjectRoot(
  absolutePath: string,
  workspaceRoot: string,
  allowedRoots: readonly string[]
) {
  const candidates = [workspaceRoot, ...allowedRoots]
    .map((root) => path.resolve(root))
    .filter((root) => isPathInsideRoot(root, absolutePath))
    .sort((left, right) => right.length - left.length);

  return candidates[0] ?? path.resolve(workspaceRoot);
}

function isPathInsideRoot(rootPath: string, absolutePath: string) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(absolutePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findLocalNodeBin(
  binaryName: string,
  startDir: string,
  boundary: string
): Promise<string | null> {
  for (const directory of ancestorsWithin(startDir, boundary)) {
    for (const candidateName of getLocalBinNames(binaryName)) {
      const candidate = path.join(directory, "node_modules", ".bin", candidateName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function getLocalBinNames(binaryName: string) {
  return process.platform === "win32" ? [`${binaryName}.cmd`, `${binaryName}.exe`, binaryName] : [binaryName];
}

async function findOnPath(commandName: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter((item) => item.length > 0)
      : [""];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === "win32" ? `${commandName}${extension.toLowerCase()}` : commandName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const candidate = path.join(directory, commandName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function packageDeclaresDependency(
  startDir: string,
  boundary: string,
  packageNames: readonly string[]
) {
  for (const directory of ancestorsWithin(startDir, boundary)) {
    const packagePath = path.join(directory, "package.json");
    const parsed = await readJsonIfExists(packagePath);
    if (!parsed) {
      continue;
    }

    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = parsed[section];
      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }

      for (const packageName of packageNames) {
        if (packageName in dependencies) {
          return true;
        }
      }
    }
  }

  return false;
}

async function findUpAny(names: readonly string[], startDir: string, boundary: string) {
  for (const name of names) {
    const match = await findUpFile(name, startDir, boundary);
    if (match) {
      return match;
    }
  }

  return null;
}

async function findUpFile(name: string, startDir: string, boundary: string) {
  for (const directory of ancestorsWithin(startDir, boundary)) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function ancestorsWithin(startDir: string, boundary: string) {
  const normalizedBoundary = path.resolve(boundary);
  const directories: string[] = [];
  let current = path.resolve(startDir);

  while (isPathInsideRoot(normalizedBoundary, current)) {
    directories.push(current);
    if (current === normalizedBoundary) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return directories;
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  const text = await readTextIfExists(filePath);
  if (text === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function isClangFormatExtension(extension: string) {
  return [
    ".c",
    ".cc",
    ".cpp",
    ".cxx",
    ".c++",
    ".h",
    ".hh",
    ".hpp",
    ".hxx",
    ".h++",
    ".ino"
  ].includes(extension);
}

function appendProcessOutput(current: string, next: string) {
  if (current.length >= MAX_PROCESS_OUTPUT_CHARS) {
    return current;
  }

  return (current + next).slice(0, MAX_PROCESS_OUTPUT_CHARS + 1);
}

function truncateProcessOutput(value: string) {
  if (value.length <= MAX_PROCESS_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_PROCESS_OUTPUT_CHARS)}\n...<truncated>`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createStatusCounts(): Record<PostWriteDiagnosticsStatus, number> {
  return {
    skipped: 0,
    pending: 0,
    ok: 0,
    issues: 0,
    failed: 0
  };
}

function createEmptyPostWriteDiagnosticsObservationStats(): PostWriteDiagnosticsObservationStats {
  return {
    totalRuns: 0,
    inlineCompletions: 0,
    pendingReturns: 0,
    backgroundCompletions: 0,
    returnedStatusCounts: createStatusCounts(),
    finalStatusCounts: createStatusCounts(),
    lastObservation: null
  };
}

function recordReturnedDiagnosticsObservation(options: {
  filePath: string;
  returnedStatus: PostWriteDiagnosticsStatus;
  returnedPending: boolean;
  inlineDurationMs: number;
}) {
  const observation: PostWriteDiagnosticsObservation = {
    filePath: options.filePath,
    returnedStatus: options.returnedStatus,
    returnedPending: options.returnedPending,
    inlineDurationMs: Math.max(0, Math.trunc(options.inlineDurationMs)),
    timestamp: new Date().toISOString()
  };

  postWriteDiagnosticsObservationStats.totalRuns += 1;
  if (options.returnedPending) {
    postWriteDiagnosticsObservationStats.pendingReturns += 1;
  } else {
    postWriteDiagnosticsObservationStats.inlineCompletions += 1;
  }
  postWriteDiagnosticsObservationStats.returnedStatusCounts[options.returnedStatus] += 1;
  postWriteDiagnosticsObservationStats.lastObservation = observation;
}

function recordFinalDiagnosticsObservation(options: {
  filePath: string;
  finalStatus: PostWriteDiagnosticsStatus;
  finalDurationMs: number;
  finalIssueCount: number;
  finalMessage?: string;
}) {
  const previous = postWriteDiagnosticsObservationStats.lastObservation;
  const observation: PostWriteDiagnosticsObservation =
    previous?.filePath === options.filePath && previous.returnedPending
      ? { ...previous }
      : {
          filePath: options.filePath,
          returnedStatus: "pending",
          returnedPending: true,
          inlineDurationMs: 0,
          timestamp: new Date().toISOString()
        };

  observation.finalStatus = options.finalStatus;
  observation.finalDurationMs = Math.max(0, Math.trunc(options.finalDurationMs));
  observation.finalIssueCount = Math.max(0, Math.trunc(options.finalIssueCount));
  observation.finalTimestamp = new Date().toISOString();
  if (options.finalMessage) {
    observation.finalMessage = options.finalMessage;
  }

  postWriteDiagnosticsObservationStats.backgroundCompletions += 1;
  postWriteDiagnosticsObservationStats.finalStatusCounts[options.finalStatus] += 1;
  postWriteDiagnosticsObservationStats.lastObservation = observation;
}

function getPostWriteDiagnosticsObservationStatsSnapshot(): PostWriteDiagnosticsObservationStatsSnapshot {
  return {
    totalRuns: postWriteDiagnosticsObservationStats.totalRuns,
    inlineCompletions: postWriteDiagnosticsObservationStats.inlineCompletions,
    pendingReturns: postWriteDiagnosticsObservationStats.pendingReturns,
    backgroundCompletions: postWriteDiagnosticsObservationStats.backgroundCompletions,
    returnedStatusCounts: { ...postWriteDiagnosticsObservationStats.returnedStatusCounts },
    finalStatusCounts: { ...postWriteDiagnosticsObservationStats.finalStatusCounts },
    lastObservation: postWriteDiagnosticsObservationStats.lastObservation
      ? { ...postWriteDiagnosticsObservationStats.lastObservation }
      : null
  };
}

function resetPostWriteDiagnosticsObservationStats() {
  const empty = createEmptyPostWriteDiagnosticsObservationStats();
  postWriteDiagnosticsObservationStats.totalRuns = empty.totalRuns;
  postWriteDiagnosticsObservationStats.inlineCompletions = empty.inlineCompletions;
  postWriteDiagnosticsObservationStats.pendingReturns = empty.pendingReturns;
  postWriteDiagnosticsObservationStats.backgroundCompletions = empty.backgroundCompletions;
  postWriteDiagnosticsObservationStats.returnedStatusCounts = empty.returnedStatusCounts;
  postWriteDiagnosticsObservationStats.finalStatusCounts = empty.finalStatusCounts;
  postWriteDiagnosticsObservationStats.lastObservation = empty.lastObservation;
}

function formatObservationPath(workspaceRoot: string, absolutePath: string) {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.replace(/\\/g, "/");
  }

  return absolutePath.replace(/\\/g, "/");
}

function truncateObservationError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_OBSERVATION_ERROR_CHARS);
}
