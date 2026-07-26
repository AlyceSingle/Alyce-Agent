import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { getMcpConfigPaths, loadMcpConfigState } from "../../mcp/config.js";
import { discoverSkills } from "../../tools/SkillTool/SkillTool.js";
import type {
  ConnectionConfigState,
  RuntimePaths,
  SessionSettings,
  SessionSettingsState
} from "../../config/runtime.js";
import type { ProjectTrustState } from "../trust/projectTrustStore.js";
import { getModelAdapterAvailability } from "../api/modelAdapters.js";
import type { ConnectorPluginDiagnostic } from "../providers/pluginConnectors.js";
import { resolveModelProfile } from "../providers/resolveModel.js";
import type { ResolvedModelProfile } from "../providers/types.js";
import { runNativeCommandWithTimeout } from "../../tools/internal/nativeCommandRunner.js";
import { resolveBundledRgScript } from "../../tools/internal/resolveRipgrep.js";
import {
  describeTypeScriptResolution,
  MIN_SUPPORTED_TYPESCRIPT_VERSION,
  type TypeScriptResolutionInfo
} from "../../services/lsp/adapters/typescriptModule.js";

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
  providerPluginDiagnostics?: ConnectorPluginDiagnostic[];
  projectTrust?: ProjectTrustState;
  snapshotDiagnostics: DoctorSnapshotDiagnostics;
}

export interface DoctorSnapshotDiagnostics {
  enabled: boolean;
  configuredEngine: "hybrid" | "git-tree" | "file-backup";
  activeEngine: "git-tree" | "file-backup" | "hybrid" | "disabled";
  gitTreeEnabled: boolean;
  gitAvailable: boolean;
  workspaceRoot: string;
  snapshotRoot: string;
  gitDirectory: string;
  retentionDays: number;
  maxTextDiffBytes: number;
  maxFileBytes: number;
  includeIgnoredExplicitPaths: boolean;
  manifestScan: boolean;
  records: number;
  latestError?: string;
  cleanupError?: string;
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
  resolveBundledRipgrep?: () => string | null;
  describeTypeScript?: () => TypeScriptResolutionInfo | null;
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
  checks.push(await checkMcpConfig(input.workspaceRoot, input.paths, input.projectTrust));
  checks.push(await checkSkills(input.paths, input.projectTrust));
  checks.push(checkProviderPlugins(input.providerPluginDiagnostics ?? []));
  checks.push(await checkRipgrep(runCommand, options.resolveBundledRipgrep ?? resolveBundledRgScript));
  checks.push(checkTypeScriptBackend(options.describeTypeScript ?? describeTypeScriptResolution));
  checks.push(await checkExecutable("git", ["--version"], "git", "Install Git and ensure git is on PATH.", runCommand, "warn"));
  checks.push(await checkAlyceDirectoryWritable(input.paths.workspaceRuntimeDirectory));
  checks.push(checkSnapshotStore(input.snapshotDiagnostics));
  checks.push(checkRequestPatches(input.requestPatchCount));

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    workspaceRoot: input.workspaceRoot,
    checks,
    summary: summarizeChecks(checks)
  };
}

function checkProviderPlugins(diagnostics: ConnectorPluginDiagnostic[]): DoctorCheck {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  if (warnings.length > 0) {
    return {
      id: "provider.plugins",
      title: "Provider plugins",
      status: "warn",
      summary: `${warnings.length} connector plugin issue(s) were found.`,
      details: diagnostics.map(formatPluginDiagnostic),
      suggestion: "Fix or remove invalid connector plugin manifests under ~/.alyce/plugins."
    };
  }

  if (diagnostics.length > 0) {
    return {
      id: "provider.plugins",
      title: "Provider plugins",
      status: "skipped",
      summary: "Connector plugins are present but no blocking issues were found.",
      details: diagnostics.map(formatPluginDiagnostic)
    };
  }

  return {
    id: "provider.plugins",
    title: "Provider plugins",
    status: "ok",
    summary: "No connector plugin issues found."
  };
}

function formatPluginDiagnostic(diagnostic: ConnectorPluginDiagnostic): string {
  return `${diagnostic.source}: ${diagnostic.pluginPath}: ${diagnostic.message}`;
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
  _hasConnectionConfig: boolean,
  env: NodeJS.ProcessEnv
): DoctorCheck {
  const resolved = resolveDoctorModelProfile(connectionState, env);
  if (!resolved.ok) {
    return {
      id: "connection.apiKey",
      title: "Model provider",
      status: "fail",
      summary: resolved.reason,
      details: [
        `Effective model: ${connectionState.effective.model}`,
        `Configured providers: ${Object.keys(connectionState.providerProfiles).join(", ") || "(none)"}`
      ],
      suggestion: "Run /connect or fix the provider profile in .alyce/config.json."
    };
  }

  const availability = getModelAdapterAvailability(resolved.profile);
  if (!availability.available) {
    const apiKeyEnv = resolved.profile.apiKeyEnv ?? "OPENAI_API_KEY";
    return {
      id: "connection.apiKey",
      title: "Model provider",
      status: "fail",
      summary: availability.reason ?? "Current model provider is not available.",
      details: [
        `Provider: ${resolved.profile.providerId}`,
        `Model: ${resolved.profile.modelId}`,
        `${apiKeyEnv} present: ${formatBoolean(Boolean(env[apiKeyEnv]?.trim()))}`,
        `Legacy API key source: ${connectionState.sources.apiKey}`
      ],
      suggestion: "Run /connect, set the provider API key/baseURL, or save provider settings in .alyce/config.json."
    };
  }

  return {
    id: "connection.apiKey",
    title: "Model provider",
    status: "ok",
    summary: resolved.profile.apiKey
      ? `Provider ${resolved.profile.providerId} has an API key.`
      : `Provider ${resolved.profile.providerId} is available without an API key.`,
    details: [
      `Provider: ${resolved.profile.providerId}`,
      `Model: ${resolved.profile.modelId}`,
      `Kind: ${resolved.profile.kind}`,
      resolved.profile.baseURL
        ? `Endpoint: ${resolved.profile.baseURL}`
        : "Endpoint: OpenAI SDK default endpoint."
    ]
  };
}

function resolveDoctorModelProfile(
  connectionState: ConnectionConfigState,
  env: NodeJS.ProcessEnv
): { ok: true; profile: ResolvedModelProfile } | { ok: false; reason: string } {
  try {
    return {
      ok: true,
      profile: resolveModelProfile(connectionState.effective.model, {
        providers: connectionState.providerProfiles,
        env
      })
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
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
      suggestion: "Run /connect, set OPENAI_BASE_URL and OPENAI_MODEL, or save baseURL/model in a provider profile."
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

  if (settings.approvalMode === "full-access") {
    return {
      id: "settings.approval",
      title: "Approval mode",
      status: "warn",
      summary: "Full Access is enabled, so tool requests can proceed without approval prompts.",
      details,
      suggestion: "Use Default or Read Only while editing untrusted repositories."
    };
  }

  if (settings.approvalMode === "auto-review") {
    return {
      id: "settings.approval",
      title: "Approval mode",
      status: "warn",
      summary: "Auto-review approval is enabled, so eligible prompts can be decided by a subagent.",
      details,
      suggestion: "Review permission messages and use Default for untrusted repositories."
    };
  }

  if (settings.additionalDirectories.length > 0) {
    return {
      id: "settings.approval",
      title: "Approval mode",
      status: "warn",
      summary: `${settings.approvalMode} approval is enabled, but extra persistent directories are allowed.`,
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
    summary: `${settings.approvalMode} approval is enabled and no persistent extra directories are configured.`,
    details
  };
}

async function checkMcpConfig(
  workspaceRoot: string,
  paths: RuntimePaths,
  projectTrust?: ProjectTrustState
): Promise<DoctorCheck> {
  const configPaths = getMcpConfigPaths(workspaceRoot, path.dirname(paths.userAlyceDirectory));
  const [projectFile, localFile, userFile] = await Promise.all([
    checkFile(configPaths.project),
    checkFile(configPaths.local),
    checkFile(configPaths.user)
  ]);
  const details = [
    formatFileStatus("Project config", projectFile),
    formatFileStatus("Local override", localFile),
    formatFileStatus("User config", userFile)
  ];
  const anyConfigExists = projectFile.exists || localFile.exists || userFile.exists;

  try {
    const state = await loadMcpConfigState(workspaceRoot, {
      homeDirectory: path.dirname(paths.userAlyceDirectory),
      trustedProject: projectTrust?.trusted !== false
    });
    const serverNames = Object.keys(state.effective.mcpServers);
    return {
      id: "mcp.config",
      title: "MCP config",
      status: "ok",
      summary: serverNames.length > 0
        ? `MCP config parsed with ${serverNames.length} effective server(s).`
        : anyConfigExists
          ? "MCP config files are valid, but no servers are configured yet."
          : "No MCP config files found yet.",
      details: [
        ...details,
        ...(projectTrust?.trusted === false
          ? ["Project MCP config is present but disabled until this workspace is trusted."]
          : []),
        ...(serverNames.length > 0
          ? serverNames.map((serverName) => `Server: ${serverName}`)
          : [])
      ],
      ...(anyConfigExists
        ? {}
        : { suggestion: "Use /mcp add to create the first MCP server entry." })
    };
  } catch (error) {
    return {
      id: "mcp.config",
      title: "MCP config",
      status: "fail",
      summary: "At least one MCP config file cannot be parsed or validated.",
      details: [...details, formatError(error)],
      suggestion: "Fix the invalid MCP config before relying on MCP tools."
    };
  }
}

async function checkSkills(
  paths: RuntimePaths,
  projectTrust?: ProjectTrustState
): Promise<DoctorCheck> {
  const projectRoot = paths.projectSkillsDirectory;
  const userRoot = paths.userSkillsDirectory;
  const [projectAccess, userAccess] = await Promise.all([
    checkDirectory(projectRoot),
    checkDirectory(userRoot)
  ]);
  const existingRoots = [projectAccess, userAccess].filter((root) => root.exists);

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

  const discovery = await discoverSkills({
    projectRoot: projectTrust?.trusted === false ? path.join(paths.workspaceRuntimeDirectory, "__disabled-project-skills") : projectRoot,
    userRoot
  });
  const details = [
    formatDirectoryStatus("Project root", projectAccess),
    formatDirectoryStatus("User root", userAccess),
    ...(projectTrust?.trusted === false && projectAccess.exists
      ? ["Project skills are present but disabled until this workspace is trusted."]
      : []),
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

  if (discovery.skills.length === 0) {
    return {
      id: "skills.discovery",
      title: "Skills",
      status: "ok",
      summary: "No skills discovered yet.",
      details: [
        ...details,
        "No SKILL.md files were found in the configured skill roots."
      ]
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

async function checkRipgrep(
  runCommand: (command: string, args: string[]) => Promise<DoctorCommandResult>,
  resolveBundledScript: () => string | null
): Promise<DoctorCheck> {
  const result = await runCommand("rg", ["--version"]);
  if (result.ok) {
    const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim())?.trim();
    return {
      id: "tool.rg",
      title: "ripgrep",
      status: "ok",
      summary: firstLine ?? "rg is available."
    };
  }

  const bundledScript = resolveBundledScript();
  if (bundledScript) {
    return {
      id: "tool.rg",
      title: "ripgrep",
      status: "warn",
      summary: result.timedOut
        ? "rg timed out; searches will use the bundled WASI ripgrep (slower)."
        : "System rg was not found; searches will use the bundled WASI ripgrep (slower).",
      details: [bundledScript],
      suggestion: "Install ripgrep and ensure rg is on PATH for the best search performance."
    };
  }

  return {
    id: "tool.rg",
    title: "ripgrep",
    status: "fail",
    summary: result.timedOut ? "rg timed out." : "rg is not available.",
    details: [
      result.error,
      result.stderr.trim()
    ].filter((detail): detail is string => Boolean(detail)),
    suggestion: "Install ripgrep and ensure rg is on PATH."
  };
}

function checkTypeScriptBackend(
  describeTypeScript: () => TypeScriptResolutionInfo | null
): DoctorCheck {
  let resolution: TypeScriptResolutionInfo | null;
  try {
    resolution = describeTypeScript();
  } catch {
    resolution = null;
  }

  if (resolution?.supported) {
    return {
      id: "tool.typescript",
      title: "TypeScript backend",
      status: "ok",
      summary: `typescript ${resolution.version} (${resolution.source})`,
      details: [resolution.modulePath]
    };
  }

  if (resolution) {
    return {
      id: "tool.typescript",
      title: "TypeScript backend",
      status: "warn",
      summary: `typescript ${resolution.version ?? "unknown"} (${resolution.source}) is below the minimum supported version ${MIN_SUPPORTED_TYPESCRIPT_VERSION}; TypeScript LSP features and diagnostics are disabled.`,
      details: [resolution.modulePath],
      suggestion: `Install typescript >=${MIN_SUPPORTED_TYPESCRIPT_VERSION} in your project, for example: npm i -D typescript.`
    };
  }

  return {
    id: "tool.typescript",
    title: "TypeScript backend",
    status: "warn",
    summary: "No typescript module was found; TypeScript LSP features and diagnostics are disabled.",
    suggestion: "Install typescript in your project, for example: npm i -D typescript."
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
        title: "Runtime storage",
        status: "fail",
        summary: "Runtime storage path exists but is not a directory.",
        details: [alyceDirectory],
        suggestion: "Remove the file or move Alyce to a valid workspace."
      };
    }

    await fs.access(alyceDirectory, fsConstants.W_OK);
    return {
      id: "storage.alyce",
      title: "Runtime storage",
      status: "ok",
      summary: "Runtime storage directory is writable.",
      details: [alyceDirectory]
    };
  } catch (error) {
    return {
      id: "storage.alyce",
      title: "Runtime storage",
      status: "fail",
      summary: "Runtime storage directory is missing or not writable.",
      details: [formatError(error), alyceDirectory],
      suggestion: "Fix directory permissions or start Alyce with a writable user config directory."
    };
  }
}

function checkSnapshotStore(snapshot: DoctorSnapshotDiagnostics): DoctorCheck {
  const details = [
    `Configured engine: ${snapshot.configuredEngine}`,
    `Active engine: ${snapshot.activeEngine}`,
    `Git-tree enabled: ${formatBoolean(snapshot.gitTreeEnabled)}`,
    `Git available: ${formatBoolean(snapshot.gitAvailable)}`,
    `Snapshot root: ${snapshot.snapshotRoot}`,
    `Git directory: ${snapshot.gitDirectory}`,
    `Retention days: ${snapshot.retentionDays}`,
    `maxTextDiffBytes: ${snapshot.maxTextDiffBytes}`,
    `maxFileBytes: ${snapshot.maxFileBytes}`,
    `includeIgnoredExplicitPaths: ${formatBoolean(snapshot.includeIgnoredExplicitPaths)}`,
    `manifestScan: ${formatBoolean(snapshot.manifestScan)}`,
    `In-memory turn records: ${snapshot.records}`
  ];
  if (snapshot.latestError) {
    details.push(`Latest snapshot error: ${snapshot.latestError}`);
  }
  if (snapshot.cleanupError) {
    details.push(`Cleanup error: ${snapshot.cleanupError}`);
  }

  if (!snapshot.enabled) {
    return {
      id: "snapshot.store",
      title: "Snapshot store",
      status: "warn",
      summary: "File snapshot capture is disabled.",
      details,
      suggestion: "Enable snapshot.enabled if you need /diff, /revert, or code rewind."
    };
  }

  if (snapshot.configuredEngine === "git-tree" && !snapshot.gitAvailable) {
    return {
      id: "snapshot.store",
      title: "Snapshot store",
      status: "fail",
      summary: "Snapshot engine is git-tree, but git is not available.",
      details,
      suggestion: "Install Git or set snapshot.engine to hybrid or file-backup."
    };
  }

  if (snapshot.gitTreeEnabled && !snapshot.gitAvailable) {
    if (!isFileHistoryOverlayEnabled(snapshot)) {
      return {
        id: "snapshot.store",
        title: "Snapshot store",
        status: "fail",
        summary: "Git-tree snapshots are unavailable and file-history overlays are disabled.",
        details,
        suggestion: "Install Git or enable snapshot.includeIgnoredExplicitPaths for hybrid fallback coverage."
      };
    }

    return {
      id: "snapshot.store",
      title: "Snapshot store",
      status: "warn",
      summary: "Git-tree snapshots are unavailable; Alyce will rely on file-history overlays.",
      details,
      suggestion: "Install Git for workspace-level shell/MCP file rewind coverage."
    };
  }

  if (snapshot.latestError) {
    return {
      id: "snapshot.store",
      title: "Snapshot store",
      status: snapshot.configuredEngine === "git-tree" ? "fail" : "warn",
      summary: "The latest snapshot operation reported an error.",
      details,
      suggestion: "Check the snapshot directory and git availability."
    };
  }

  if (snapshot.cleanupError) {
    return {
      id: "snapshot.store",
      title: "Snapshot store",
      status: "warn",
      summary: "Snapshot cleanup reported an error.",
      details,
      suggestion: "Check .alyce snapshot directory permissions."
    };
  }

  return {
    id: "snapshot.store",
    title: "Snapshot store",
    status: "ok",
    summary: `Snapshot engine ${snapshot.configuredEngine} is configured.`,
    details
  };
}

function isFileHistoryOverlayEnabled(snapshot: DoctorSnapshotDiagnostics) {
  return snapshot.enabled &&
    (snapshot.configuredEngine === "file-backup" ||
      (snapshot.configuredEngine === "hybrid" && snapshot.includeIgnoredExplicitPaths));
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

async function checkFile(targetPath: string): Promise<{
  path: string;
  exists: boolean;
  readable: boolean;
  error?: string;
}> {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      return {
        path: targetPath,
        exists: true,
        readable: false,
        error: "not a file"
      };
    }

    await fs.readFile(targetPath, "utf8");
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

function formatDirectoryStatus(
  label: string,
  directory: Awaited<ReturnType<typeof checkDirectory>>
) {
  if (!directory.exists) {
    return `${label}: ${directory.path} (missing)`;
  }

  if (!directory.readable) {
    return `${label}: ${directory.path} (${directory.error ?? "not readable"})`;
  }

  return `${label}: ${directory.path} (ready)`;
}

function formatFileStatus(
  label: string,
  file: Awaited<ReturnType<typeof checkFile>>
) {
  if (!file.exists) {
    return `${label}: ${file.path} (missing)`;
  }

  if (!file.readable) {
    return `${label}: ${file.path} (${file.error ?? "not readable"})`;
  }

  return `${label}: ${file.path} (present)`;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
