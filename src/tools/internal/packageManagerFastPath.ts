import { TurnInterruptedError, getAbortReason } from "../../core/abort.js";
import { JS_PACKAGE_MANAGER_EXECUTABLE_REGEX } from "./jsPackageManagers.js";
import { runNativeCommandWithTimeout } from "./nativeCommandRunner.js";

const SHELL_SYNTAX_PATTERN = /[\0;&|<>(){}$`#%^]|[\r\n]/;
export const WINDOWS_NATIVE_PACKAGE_MANAGER_FAST_PATH_NOTICE =
  "Windows compatibility: simple package-manager command will run through Alyce native argv execution.";

export interface FastPathCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export function resolveSimplePackageManagerFastPath(
  command: string,
  platform: NodeJS.Platform = process.platform
): string[] | null {
  if (platform !== "win32" || SHELL_SYNTAX_PATTERN.test(command)) {
    return null;
  }

  const argv = tokenizeSimpleCommand(command);
  if (!argv || argv.length === 0) {
    return null;
  }

  const executable = argv[0] ?? "";
  if (executable.includes("/") || executable.includes("\\")) {
    return null;
  }

  return JS_PACKAGE_MANAGER_EXECUTABLE_REGEX.test(executable) ? argv : null;
}

export async function runSimplePackageManagerFastPath(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  interruptedMessage: string;
}): Promise<FastPathCommandResult | null> {
  const argv = resolveSimplePackageManagerFastPath(options.command);
  if (!argv) {
    return null;
  }

  const result = await runNativeCommandWithTimeout(argv, {
    cwd: options.cwd,
    env: process.env,
    timeoutMs: options.timeoutMs,
    abortSignal: options.abortSignal
  });

  if (result.error === "aborted") {
    throw new TurnInterruptedError(
      getAbortReason(options.abortSignal) ?? "aborted",
      options.interruptedMessage
    );
  }

  return {
    exitCode: result.exitCode,
    signal: typeof result.signal === "string" ? result.signal : null,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: appendNativeError(result.stderr, result.error)
  };
}

function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) {
      continue;
    }

    if (quote) {
      if (char === quote) {
        if (command[index + 1] === quote) {
          current += quote;
          index += 1;
          continue;
        }

        quote = null;
        continue;
      }

      current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    return null;
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}

function appendNativeError(stderr: string, error: string | undefined): string {
  if (!error || error === "timeout") {
    return stderr;
  }

  if (!stderr) {
    return error;
  }

  const newline = stderr.includes("\r\n") ? "\r\n" : "\n";
  return stderr.endsWith("\n") ? `${stderr}${error}` : `${stderr}${newline}${error}`;
}
