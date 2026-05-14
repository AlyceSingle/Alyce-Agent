import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectMcpConfig } from "../../mcp/config.js";
import { discoverSkills } from "../../tools/SkillTool/SkillTool.js";
import type {
  ConnectionConfigState,
  RuntimePaths,
  SessionSettings,
  SessionSettingsState
} from "../../config/runtime.js";
import { runNativeCommandWithTimeout } from "../../tools/internal/nativeCommandRunner.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  summary: string;
  details?: string[];
  suggestion?: string;
}

export interface DoctorReport {
  generatedAt: string;
  workspaceRoot: string;
  checks: DoctorCheck[];
  summary: Record<DoctorCheckStatus, number>;
}

export interface DoctorRuntimeInput {
  workspaceRoot: string;
  paths: RuntimePaths;
  connectionState: ConnectionConfigState;
  settingsState: SessionSettingsState;
  settings: SessionSettings;
  currentModel: string;
  hasConnectionConfig: boolean;
  allowedRoots: string[];
  requestPatchCount: number;
}

export interface DoctorCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  now?: Date;
  runCommand?: (command: string, args: string[]) => Promise<DoctorCommandResult>;
}

const REQUIRED_NODE_VERSION = "20.10.0";
const COMMAND_CHECK_TIMEOUT_MS = 5_000;

export async function runDoctorDiagnostics(
  input: DoctorRuntimeInput,
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const nodeVersion = normalizeVersion(options.nodeVersion ?? process.versions.node);
  const runCommand = options.runCommand ?? runCommandWithTimeout;
  const checks: DoctorCheck[] = [];

  checks.push(checkNodeVersion(nodeVersion));
  checks.push(checkTty(options));
  checks.push(await checkWorkspace(input.workspaceRoot));
  checks.push(await checkProjectIntegrity(input.workspaceRoot));
  checks.push(checkConnection(input.connectionState, input.hasConnectionConfig, env));
  checks.push(checkEndpointAndModel(input.connectionState, input.currentModel));
  checks.push(checkSettings(input.settingsState, input.settings));
  checks.push(checkApprovalRisk(input.settings, input.allowedRoots));
  checks.push(await checkMcpConfig(input.workspaceRoot));
  checks.push(await checkSkills(input.workspaceRoot));
  checks.push(await checkExecutable("rg", ["--version"], "ripgrep", "Install ripgrep and ensure rg is on PATH.", runCommand, "fail"));
  checks.push(await checkExecutable("git", ["--version"], "git", "Install Git and ensure git is on PATH.", runCommand, "warn"));
  checks.push(await checkAlyceDirectoryWritable(input.paths.alyceDirectory));
  checks.push(checkRequestPatches(input.requestPatchCount));

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    workspaceRoot: input.workspaceRoot,
    checks,
    summary: summarizeChecks(checks)
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "Alyce Doctor",
    `Generated: ${report.generatedAt}`,
    `Workspace: ${report.workspaceRoot}`,
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skipped} skipped`,
    ""
  ];

  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.title}: ${check.summary}`);
    for (const detail of check.details ?? []) {
      lines.push(`  - ${detail}`);
    }
    if (check.suggestion) {
      lines.push(`  Fix: ${check.suggestion}`);
    }
  }

  return lines.join("\n");
}

function checkNodeVersion(version: string): DoctorCheck {
  if (!version) {
    return {
      id: "node.version",
      title: "Node runtime",
      status: "fail",
      summary: "Node version could not be detected.",
      suggestion: `Use Node >= ${REQUIRED_NODE_VERSION}.`
    };
  }

  if (!isVersionAtLeast(version, REQUIRED_NODE_VERSION)) {
    return {
      id: "node.version",
      title: "Node runtime",
      status: "fail",
      summary: `Node ${version} is below the required ${REQUIRED_NODE_VERSION}.`,
      suggestion: `Upgrade Node to >= ${REQUIRED_NODE_VERSION}.`
    };
  }

  return {
    id: "node.version",
    title: "Node runtime",
    status: "ok",
    summary: `Node ${version} satisfies >= ${REQUIRED_NODE_VERSION}.`
  };
}

function checkTty(options: DoctorOptions): DoctorCheck {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinIsTTY || !stdoutIsTTY) {
    return {
      id: "terminal.tty",
      title: "Interactive terminal",
      status: "fail",
      summary: "Alyce is not running with an interactive stdin/stdout pair.",
      details: [
        `stdin TTY: ${formatBoolean(stdinIsTTY)}`,
        `stdout TTY: ${formatBoolean(stdoutIsTTY)}`
      ],
      suggestion: "Run Alyce from a real terminal instead of piping stdin/stdout."
    };
  }

  return {
    id: "terminal.tty",
    title: "Interactive terminal",
    status: "ok",
    summary: "stdin and stdout are interactive TTY streams."
  };
}

async function checkWorkspace(workspaceRoot: string): Promise<DoctorCheck> {
  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) {
      return {
        id: "workspace.root",
        title: "Workspace",
        status: "fail",
        summary: "Workspace path is not a directory.",
        details: [workspaceRoot],
        suggestion: "Start Alyce with a valid project directory."
      };
    }

    await fs.access(workspaceRoot);
    return {
      id: "workspace.root",
      title: "Workspace",
      status: "ok",
      summary: "Workspace directory is readable.",
      details: [workspaceRoot]
    };
  } catch (error) {
    return {
      id: "workspace.root",
      title: "Workspace",
      status: "fail",
      summary: "Workspace directory cannot be read.",
      details: [formatError(error)],
      suggestion: "Check that the workspace exists and the current user can read it."
    };
  }
}

async function checkProjectIntegrity(workspaceRoot: string): Promise<DoctorCheck> {
  const packagePath = path.join(workspaceRoot, "package.json");
  const srcIndexPath = path.join(workspaceRoot, "src", "index.ts");
  const distIndexPath = path.join(workspaceRoot, "dist", "index.js");
  const missing: string[] = [];
  const warnings: string[] = [];

  const packageExists = await pathExists(packagePath);
  if (!packageExists) {
    missing.push("package.json");
  } else {
    try {
      JSON.parse(await fs.readFile(packagePath, "utf8"));
    } catch (error) {
      return {
        id: "project.integrity",
        title: "Project files",
        status: "fail",
        summary: "package.json exists but is not valid JSON.",
        details: [formatError(error)],
        suggestion: "Fix package.json before running Alyce."
      };
    }
  }

  if (!await pathExists(srcIndexPath)) {
    missing.push("src/index.ts");
  }

  if (!await pathExists(distIndexPath)) {
    warnings.push("dist/index.js is missing; run npm run build before npm start or package publishing.");
  }

  if (missing.length > 0) {
    return {
      id: "project.integrity",
      title: "Project files",
      status: "fail",
      summary: "Required project files are missing.",
      details: missing,
      suggestion: "Restore the missing source files before running Alyce."
    };
  }

  if (warnings.length > 0) {
    return {
      id: "project.integrity",
      title: "Project files",
      status: "warn",
      summary: "Source files are present, but build output is missing.",
      details: warnings,
      suggestion: "Run npm run build when you need compiled dist output."
    };
  }

  return {
    id: "project.integrity",
    title: "Project files",
    status: "ok",
    summary: "package.json, src/index.ts, and dist/index.js are present."
  };
}

function checkConnection(
  connectionState: ConnectionConfigState,
  hasConnectionConfig: boolean,
  env: NodeJS.ProcessEnv
): DoctorCheck {
  const apiKey = connectionState.effective.apiKey.trim();
  if (!hasConnectionConfig || apiKey.length === 0) {
    return {
      id: "connection.apiKey",
      title: "API key",
      status: "fail",
      summary: "No effective API key is configured.",
      details: [
        `OPENAI_API_KEY present: ${formatBoolean(Boolean(env.OPENAI_API_KEY?.trim()))}`,
        `Effective source: ${connectionState.sources.apiKey}`
      ],
      suggestion: "Run /setup, set OPENAI_API_KEY, or save apiKey in .alyce/config.json."
    };
  }

  return {
    id: "connection.apiKey",
    title: "API key",
    status: "ok",
    summary: `API key is configured from ${connectionState.sources.apiKey}.`,
    details: [`OPENAI_API_KEY present: ${formatBoolean(Boolean(env.OPENAI_API_KEY?.trim()))}`]
  };
}

function checkEndpointAndModel(
  connectionState: ConnectionConfigState,
  currentModel: string
): DoctorCheck {
  const baseURL = connectionState.effective.baseURL;
  const model = currentModel.trim() || connectionState.effective.model.trim();
  const hasExplicitBaseURL = connectionState.sources.baseURL !== "default" && Boolean(baseURL);
  const hasExplicitModel = connectionState.sources.model !== "default";

  if (!model) {
    return {
      id: "connection.model",
      title: "Endpoint and model",
      status: "fail",
      summary: "No model is configured.",
      suggestion: "Run /model <name>, set OPENAI_MODEL, or save model in Alyce settings."
    };
  }

  if (baseURL) {
    try {
      new URL(baseURL);
    } catch {
      return {
        id: "connection.model",
        title: "Endpoint and model",
        status: "fail",
        summary: `OPENAI_BASE_URL/baseURL is not a valid URL: ${baseURL}`,
        suggestion: "Use a full URL such as https://api.openai.com/v1."
      };
    }
  }

  if (!hasExplicitBaseURL || !hasExplicitModel) {
    const missing = [
      hasExplicitBaseURL ? null : "OPENAI_BASE_URL/baseURL is not explicitly configured.",
      hasExplicitModel ? null : "OPENAI_MODEL/model is not explicitly configured."
    ].filter((detail): detail is string => detail !== null);

    return {
      id: "connection.model",
      title: "Endpoint and model",
      status: "warn",
      summary: "Endpoint or model is using a built-in default.",
      details: [
        ...missing,
        baseURL
          ? `Effective endpoint: ${baseURL}`
          : "Effective endpoint: OpenAI SDK default endpoint.",
        `Effective model: ${model}`,
        `Model source: ${connectionState.sources.model}`,
        `Base URL source: ${connectionState.sources.baseURL}`
      ],
      suggestion: "Run /setup, set OPENAI_BASE_URL and OPENAI_MODEL, or save baseURL/model in Alyce connection settings."
    };
  }

  return {
    id: "connection.model",
    title: "Endpoint and model",
    status: "ok",
    summary: baseURL
      ? `Model ${model} will use ${baseURL}.`
      : `Model ${model} will use the OpenAI SDK default endpoint.`,
    details: [
      `Model source: ${connectionState.sources.model}`,
      `Base URL source: ${connectionState.sources.baseURL}`
    ]
  };
}

function checkSettings(
  settingsState: SessionSettingsState,
  settings: SessionSettings
): DoctorCheck {
  return {
    id: "settings.loaded",
    title: "Runtime settings",
    status: "ok",
    summary: "Runtime settings are loaded.",
    details: [
      `Project settings path: ${settingsState.projectPath}`,
      `User settings path: ${settingsState.saveTargetPath}`,
      `maxSteps: ${settings.maxSteps}`,
      `commandTimeoutMs: ${settings.commandTimeoutMs}`
    ]
  };
}

function checkApprovalRisk(settings: SessionSettings, allowedRoots: string[]): DoctorCheck {
  const details = [
    `Approval mode: ${settings.approvalMode}`,
    `Allowed roots: ${allowedRoots.length}`
  ];

  if (settings.additionalDirectories.length > 0) {
    details.push(`Persistent additional directories: ${settings.additionalDirectories.length}`);
  }

  if (settings.approvalMode === "auto") {
    return {
      id: "settings.approval",
      title: "Approval mode",
      status: "warn",
      summary: "Auto approval is enabled, so tool requests can proceed with fewer stops.",
      details,
      suggestion: "Use manual approval while editing untrusted repositories."
    };
  }

  if (settings.additionalDirectories.length > 0) {
    return {
      id: "settings.approval",
      title: "Approval mode",
      status: "warn",
      summary: "Manual approval is enabled, but extra persistent directories are allowed.",
      details: [
        ...details,
        ...settings.additionalDirectories.map((directory) => `Allowed: ${directory}`)
      ],
      suggestion: "Remove directories you no longer need from runtime settings."
    };
  }

  return {
    id: "settings.approval",
    title: "Approval mode",
    status: "ok",
    summary: "Manual approval is enabled and no persistent extra directories are configured.",
    details
  };
}

async function checkMcpConfig(workspaceRoot: string): Promise<DoctorCheck> {
  const configPath = path.join(workspaceRoot, ".alyce", "mcp.json");
  if (!await pathExists(configPath)) {
    return {
      id: "mcp.config",
      title: "MCP config",
      status: "skipped",
      summary: "No project MCP config file found.",
      details: [configPath]
    };
  }

  try {
    const config = await loadProjectMcpConfig(workspaceRoot);
    const serverNames = Object.keys(config.mcpServers);
    return {
      id: "mcp.config",
      title: "MCP config",
      status: "ok",
      summary: `MCP config parsed with ${serverNames.length} server(s).`,
      details: serverNames.length > 0 ? serverNames : [configPath]
    };
  } catch (error) {
    return {
      id: "mcp.config",
      title: "MCP config",
      status: "fail",
      summary: ".alyce/mcp.json cannot be parsed or validated.",
      details: [formatError(error)],
      suggestion: "Fix .alyce/mcp.json before relying on MCP tools."
    };
  }
}

async function checkSkills(workspaceRoot: string): Promise<DoctorCheck> {
  const projectRoot = path.join(workspaceRoot, ".alyce", "skills");
  const userRoot = path.join(os.homedir(), ".alyce", "skills");
  const [projectAccess, userAccess] = await Promise.all([
    checkDirectory(projectRoot),
    checkDirectory(userRoot)
  ]);
  const existingRoots = [projectAccess, userAccess].filter((root) => root.exists);

  if (existingRoots.length === 0) {
    return {
      id: "skills.discovery",
      title: "Skills",
      status: "skipped",
      summary: "No skill roots found.",
      details: [projectRoot, userRoot]
    };
  }

  const inaccessibleRoots = existingRoots.filter((root) => !root.readable);
  if (inaccessibleRoots.length > 0) {
    return {
      id: "skills.discovery",
      title: "Skills",
      status: "warn",
      summary: "At least one skill root exists but cannot be read.",
      details: inaccessibleRoots.map((root) => `${root.path}: ${root.error ?? "not readable"}`),
      suggestion: "Fix permissions on the unreadable skill root."
    };
  }

  const discovery = await discoverSkills({ projectRoot, userRoot });
  const details = [
    `Project root: ${projectRoot}`,
    `User root: ${userRoot}`,
    ...discovery.duplicateWarnings
  ];

  if (discovery.duplicateWarnings.length > 0) {
    return {
      id: "skills.discovery",
      title: "Skills",
      status: "warn",
      summary: `Discovered ${discovery.skills.length} skill(s), with duplicate names.`,
      details,
      suggestion: "Rename or remove duplicate skills so discovery is predictable."
    };
  }

  return {
    id: "skills.discovery",
    title: "Skills",
    status: "ok",
    summary: `Discovered ${discovery.skills.length} skill(s).`,
    details
  };
}

async function checkExecutable(
  command: string,
  args: string[],
  title: string,
  suggestion: string,
  runCommand: (command: string, args: string[]) => Promise<DoctorCommandResult>,
  failureStatus: "warn" | "fail"
): Promise<DoctorCheck> {
  const result = await runCommand(command, args);
  if (!result.ok) {
    return {
      id: `tool.${command}`,
      title,
      status: failureStatus,
      summary: result.timedOut
        ? `${command} timed out.`
        : `${command} is not available.`,
      details: [
        result.error,
        result.stderr.trim()
      ].filter((detail): detail is string => Boolean(detail)),
      suggestion
    };
  }

  const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim())?.trim();
  return {
    id: `tool.${command}`,
    title,
    status: "ok",
    summary: firstLine ?? `${command} is available.`
  };
}

async function checkAlyceDirectoryWritable(alyceDirectory: string): Promise<DoctorCheck> {
  try {
    const stat = await fs.stat(alyceDirectory);
    if (!stat.isDirectory()) {
      return {
        id: "storage.alyce",
        title: ".alyce storage",
        status: "fail",
        summary: ".alyce path exists but is not a directory.",
        details: [alyceDirectory],
        suggestion: "Remove the file at .alyce or move Alyce to a valid workspace."
      };
    }

    await fs.access(alyceDirectory, fsConstants.W_OK);
    return {
      id: "storage.alyce",
      title: ".alyce storage",
      status: "ok",
      summary: ".alyce directory is writable.",
      details: [alyceDirectory]
    };
  } catch (error) {
    return {
      id: "storage.alyce",
      title: ".alyce storage",
      status: "fail",
      summary: ".alyce directory is missing or not writable.",
      details: [formatError(error), alyceDirectory],
      suggestion: "Fix directory permissions or start Alyce in a writable workspace."
    };
  }
}

function checkRequestPatches(requestPatchCount: number): DoctorCheck {
  if (requestPatchCount === 0) {
    return {
      id: "request.patches",
      title: "Request patches",
      status: "ok",
      summary: "No request patch overrides are active."
    };
  }

  return {
    id: "request.patches",
    title: "Request patches",
    status: "warn",
    summary: `${requestPatchCount} request patch override(s) are active.`,
    suggestion: "Disable request patches unless you intentionally need API payload overrides."
  };
}

async function runCommandWithTimeout(
  command: string,
  args: string[]
): Promise<DoctorCommandResult> {
  const result = await runNativeCommandWithTimeout([command, ...args], {
    timeoutMs: COMMAND_CHECK_TIMEOUT_MS
  });

  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: result.error
  };
}

function summarizeChecks(checks: DoctorCheck[]): Record<DoctorCheckStatus, number> {
  return checks.reduce<Record<DoctorCheckStatus, number>>(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    {
      ok: 0,
      warn: 0,
      fail: 0,
      skipped: 0
    }
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function checkDirectory(targetPath: string): Promise<{
  path: string;
  exists: boolean;
  readable: boolean;
  error?: string;
}> {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) {
      return {
        path: targetPath,
        exists: true,
        readable: false,
        error: "not a directory"
      };
    }

    await fs.readdir(targetPath);
    return {
      path: targetPath,
      exists: true,
      readable: true
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        path: targetPath,
        exists: false,
        readable: false
      };
    }

    return {
      path: targetPath,
      exists: true,
      readable: false,
      error: formatError(error)
    };
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function isVersionAtLeast(actual: string, required: string): boolean {
  const actualParts = actual.split(".").map((part) => Number.parseInt(part, 10));
  const requiredParts = required.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const left = Number.isFinite(actualParts[index]) ? actualParts[index]! : 0;
    const right = Number.isFinite(requiredParts[index]) ? requiredParts[index]! : 0;
    if (left > right) {
      return true;
    }
    if (left < right) {
      return false;
    }
  }

  return true;
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
