import fs from "node:fs";
import path from "node:path";

const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);
const WINDOWS_CMD_SHIM_COMMANDS = ["corepack", "pnpm", "yarn"] as const;
const WINDOWS_UNSAFE_CMD_ARGUMENT_PATTERN = /[\0&|<>^%\r\n]/;

export interface WindowsNativeCommandInvocation {
  command: string;
  args: string[];
  windowsHide: true;
  windowsVerbatimArguments?: boolean;
  usesWindowsExitCodeShim: boolean;
}

interface WindowsResolutionOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  cmdCommands?: readonly string[];
}

export function resolveWindowsCommandShim(
  command: string,
  cmdCommands: readonly string[] = WINDOWS_CMD_SHIM_COMMANDS,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") {
    return command;
  }

  const basename = path.win32.basename(command).toLowerCase();
  if (path.win32.extname(basename)) {
    return command;
  }

  return cmdCommands.includes(basename) ? `${command}.cmd` : command;
}

export function resolveNpmArgvForWindows(
  argv: readonly string[],
  options: WindowsResolutionOptions = {}
): string[] | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || argv.length === 0) {
    return null;
  }

  const command = argv[0] ?? "";
  if (isExplicitWindowsCommandPath(command)) {
    return null;
  }

  const basename = path.win32.basename(command).toLowerCase().replace(/\.(cmd|exe|bat)$/i, "");
  const cliName = basename === "npm" ? "npm-cli.js" : basename === "npx" ? "npx-cli.js" : null;
  if (!cliName) {
    return null;
  }

  const execPath = options.execPath ?? process.execPath;
  const cliPath = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", cliName);
  const existsSync = options.existsSync ?? fs.existsSync;
  if (existsSync(cliPath)) {
    return [execPath, cliPath, ...argv.slice(1)];
  }

  const extension = path.win32.extname(command);
  return [extension ? command : `${command}.cmd`, ...argv.slice(1)];
}

function isExplicitWindowsCommandPath(command: string): boolean {
  return /[\\/:]/.test(command);
}

export function resolveWindowsNativeCommandInvocation(
  argv: readonly string[],
  options: WindowsResolutionOptions = {}
): WindowsNativeCommandInvocation {
  if (argv.length === 0 || !argv[0]) {
    throw new Error("Native command argv must include a command.");
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      command: argv[0],
      args: [...argv.slice(1)],
      windowsHide: true,
      usesWindowsExitCodeShim: false
    };
  }

  const npmArgv = resolveNpmArgvForWindows(argv, options);
  const resolvedArgv = npmArgv ?? [
    resolveWindowsCommandShim(argv[0], options.cmdCommands, platform),
    ...argv.slice(1)
  ];
  const resolvedCommand = resolvedArgv[0] ?? argv[0];
  if (isWindowsBatchCommand(resolvedCommand, platform)) {
    return {
      command: resolveTrustedWindowsCmdExe(options.env),
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(resolvedCommand, resolvedArgv.slice(1))],
      windowsHide: true,
      windowsVerbatimArguments: true,
      usesWindowsExitCodeShim: true
    };
  }

  return {
    command: resolvedCommand,
    args: resolvedArgv.slice(1),
    windowsHide: true,
    usesWindowsExitCodeShim: npmArgv !== null
  };
}

export function resolveTrustedWindowsCmdExe(env: NodeJS.ProcessEnv = process.env): string {
  const root =
    resolveTrustedWindowsRoot(getEnvValueCaseInsensitive(env, "SystemRoot")) ??
    resolveTrustedWindowsRoot(getEnvValueCaseInsensitive(env, "WINDIR")) ??
    "C:\\Windows";
  return path.win32.join(root, "System32", "cmd.exe");
}

export function buildCmdExeCommandLine(command: string, args: readonly string[]): string {
  const commandLine = [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
  return `"${commandLine}"`;
}

export function isWindowsBatchCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "win32" && WINDOWS_BATCH_EXTENSIONS.has(path.win32.extname(command).toLowerCase());
}

function resolveTrustedWindowsRoot(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || /[\0;&|<>^%\r\n]/.test(trimmed)) {
    return null;
  }

  const normalized = trimTrailingSeparators(path.win32.normalize(trimmed));
  if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) {
    return null;
  }

  const parsed = path.win32.parse(normalized);
  if (!/^[a-z]:\\$/i.test(parsed.root) || normalized.length <= parsed.root.length) {
    return null;
  }

  return normalized;
}

function getEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (direct !== undefined) {
    return direct;
  }

  const upperKey = key.toUpperCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toUpperCase() === upperKey);
  return actualKey ? env[actualKey] : undefined;
}

function trimTrailingSeparators(value: string): string {
  const parsed = path.win32.parse(value);
  let trimmed = value;
  while (trimmed.length > parsed.root.length && /[\\/]/.test(trimmed.at(-1) ?? "")) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed;
}

function escapeForCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_ARGUMENT_PATTERN.test(arg)) {
    throw new Error(`Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}.`);
  }

  if (!/[\s"]/u.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/"/g, "\"\"")}"`;
}
