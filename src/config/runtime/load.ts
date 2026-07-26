import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseRequestPatchOperations,
  type RequestPatchOperation
} from "../../core/api/requestPatch.js";
import {
  loadConnectorPlugins
} from "../../core/providers/pluginConnectors.js";
import { getBuiltInProviderConnectors } from "../../core/providers/connectors/index.js";
import { getProjectTrustState } from "../../core/trust/projectTrustStore.js";
import {
  logStartupTiming,
  measureStartupTiming
} from "../../core/startup/startupTiming.js";
import type { ConnectionConfigLayer, RuntimeConfig } from "./types.js";
import {
  configRelativePath,
  getArgValue,
  parseBoolean,
  parsePositiveInt
} from "./shared.js";
import {
  ConnectionConfigFileSchema,
  SessionSettingsFileSchema,
  readJsonConfig,
  type SessionSettingsFile
} from "./configFiles.js";
import { ensureRuntimeStoragePaths, getRuntimePaths } from "./paths.js";
import {
  buildConnectionConfigState,
  resolveConnectionFromCli,
  resolveConnectionFromEnv
} from "./connection.js";
import {
  buildSessionSettingsState,
  normalizeSessionSettingsFile,
  resolveSettingsFromCli,
  resolveSettingsFromEnv
} from "./sessionSettings.js";

export async function loadRuntimeConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<RuntimeConfig> {
  const workspaceRoot = path.resolve(getArgValue(argv, "--cwd") || env.AGENT_WORKSPACE || ".");
  logStartupTiming("runtime:load:start", { workspaceRoot });
  const paths = await measureStartupTiming("runtime:getRuntimePaths", () =>
    Promise.resolve(getRuntimePaths(workspaceRoot))
  );
  logStartupTiming("runtime:paths", {
    workspaceRoot: paths.workspaceRoot,
    projectAlyceDirectory: paths.projectAlyceDirectory,
    userAlyceDirectory: paths.userAlyceDirectory,
    sameProjectAndUserAlyce: paths.projectAlyceDirectory === paths.userAlyceDirectory
  });
  const bootstrap = await measureStartupTiming("runtime:ensureStoragePaths", () =>
    ensureRuntimeStoragePaths(paths)
  );
  logStartupTiming("runtime:bootstrap", {
    firstRun: bootstrap.firstRun,
    createdCount: bootstrap.createdPaths.length,
    existingCount: bootstrap.existingPaths.length,
    failedCount: bootstrap.failedPaths.length
  });
  const projectTrust = await measureStartupTiming("runtime:getProjectTrustState", () =>
    getProjectTrustState(workspaceRoot, {
      userAlyceDirectory: paths.userAlyceDirectory
    })
  );
  const projectTrusted = projectTrust.trusted;
  logStartupTiming("runtime:projectTrust", {
    trusted: projectTrusted
  });
  const enableProjectPlugins = projectTrusted &&
    parseBoolean(env.ALYCE_ENABLE_PROJECT_PROVIDER_PLUGINS, false);
  const [projectConnection, userConnection, projectSettingsFile, userSettingsFile, pluginResult] =
    await measureStartupTiming("runtime:loadConfigAndPlugins", () =>
      Promise.all([
        measureStartupTiming(
          "runtime:readProjectConnectionConfig",
          () => projectTrusted
            ? readJsonConfig(paths.connectionConfigPath, ConnectionConfigFileSchema)
            : Promise.resolve({} as Partial<ConnectionConfigLayer>),
          { path: paths.connectionConfigPath, enabled: projectTrusted }
        ),
        measureStartupTiming(
          "runtime:readUserConnectionConfig",
          () => readJsonConfig(paths.userConnectionConfigPath, ConnectionConfigFileSchema),
          { path: paths.userConnectionConfigPath }
        ),
        measureStartupTiming(
          "runtime:readProjectSettings",
          () => projectTrusted
            ? readJsonConfig(paths.settingsConfigPath, SessionSettingsFileSchema)
            : Promise.resolve({} as Partial<SessionSettingsFile>),
          { path: paths.settingsConfigPath, enabled: projectTrusted }
        ),
        measureStartupTiming(
          "runtime:readUserSettings",
          () => readJsonConfig(paths.userSettingsConfigPath, SessionSettingsFileSchema),
          { path: paths.userSettingsConfigPath }
        ),
        measureStartupTiming(
          "runtime:loadConnectorPlugins",
          () => loadConnectorPlugins({
            userPluginsDirectory: paths.userPluginsDirectory,
            projectPluginsDirectory: paths.projectPluginsDirectory,
            enableProjectPlugins,
            projectTrustDisabledReason: projectTrusted
              ? undefined
              : "Project connector plugins are disabled until this workspace is trusted."
          }),
          {
            userPluginsDirectory: paths.userPluginsDirectory,
            projectPluginsDirectory: paths.projectPluginsDirectory,
            enableProjectPlugins
          }
        )
      ])
    );
  const projectSettings = normalizeSessionSettingsFile(projectSettingsFile);
  const userSettings = normalizeSessionSettingsFile(userSettingsFile);

  const connectionState = await measureStartupTiming("runtime:buildConnectionConfigState", () =>
    Promise.resolve(buildConnectionConfigState(paths, {
      user: userConnection,
      project: projectConnection,
      env: resolveConnectionFromEnv(env),
      cli: resolveConnectionFromCli(argv),
      pluginProviders: pluginResult.providerProfiles
    }))
  );
  const cliSettings = await resolveSettingsFromCli(argv);
  const settingsState = await measureStartupTiming("runtime:buildSessionSettingsState", () =>
    Promise.resolve(buildSessionSettingsState(paths, {
      project: projectSettings,
      user: userSettings,
      env: resolveSettingsFromEnv(env),
      cli: cliSettings
    }))
  );
  logStartupTiming("runtime:load:end", {
    providerConnectorCount: pluginResult.connectors.length,
    providerPluginDiagnosticCount: pluginResult.diagnostics.length
  });

  return {
    paths,
    bootstrap,
    projectTrust,
    connection: connectionState.effective,
    connectionState,
    settings: settingsState.effective,
    settingsState,
    providerConnectors: [
      ...getBuiltInProviderConnectors(),
      ...pluginResult.connectors
    ],
    providerPluginProfiles: pluginResult.providerProfiles,
    providerPluginDiagnostics: pluginResult.diagnostics,
    requestPatches: await resolveRequestPatches(argv, env),
    memory: {
      directory: env.AGENT_MEMORY_DIR || configRelativePath(
        paths.workspaceRoot,
        paths.memoryDirectory
      ),
      fileName: env.AGENT_MEMORY_FILE || "MEMORY.md",
      maxSessionEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_SESSION, 30),
      maxPersistentEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PERSISTENT, 200),
      maxPromptEntries: parsePositiveInt(env.AGENT_MEMORY_MAX_PROMPT, 20),
      sessionMemory: {
        enabled: parseBoolean(
          env.AGENT_SESSION_MEMORY_ENABLED ?? env.AGENT_MEMORY_AUTO_SUMMARY,
          true
        ),
        initialTokens: parsePositiveInt(env.AGENT_SESSION_MEMORY_INIT_TOKENS, 10_000),
        updateTokens: parsePositiveInt(env.AGENT_SESSION_MEMORY_UPDATE_TOKENS, 5_000),
        toolCallsBetweenUpdates: parsePositiveInt(env.AGENT_SESSION_MEMORY_TOOL_CALLS, 3),
        timeoutMs: parsePositiveInt(env.AGENT_SESSION_MEMORY_TIMEOUT_MS, 180_000),
        maxFailures: parsePositiveInt(env.AGENT_SESSION_MEMORY_MAX_FAILURES, 3),
        staleMs: parsePositiveInt(env.AGENT_SESSION_MEMORY_STALE_MS, 60_000),
        maxMessagesForExtraction: parsePositiveInt(env.AGENT_SESSION_MEMORY_WINDOW_MESSAGES, 80),
        maxCharsPerMessage: parsePositiveInt(env.AGENT_SESSION_MEMORY_MAX_CHARS_PER_MESSAGE, 1_500)
      }
    }
  };
}

async function resolveRequestPatches(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<RequestPatchOperation[]> {
  const directValue = getArgValue(argv, "--request-patch") ?? env.AGENT_OPENAI_REQUEST_PATCH;
  const fileValue = getArgValue(argv, "--request-patch-file") ?? env.AGENT_OPENAI_REQUEST_PATCH_FILE;

  if (directValue && fileValue) {
    throw new Error("Cannot use --request-patch and --request-patch-file at the same time.");
  }

  if (!directValue && !fileValue) {
    return [];
  }

  if (fileValue) {
    const absolutePath = path.resolve(fileValue);
    try {
      const raw = await fs.readFile(absolutePath, "utf8");
      return parseRequestPatchOperations(raw, absolutePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read request patch file: ${absolutePath}. ${message}`);
    }
  }

  return parseRequestPatchOperations(
    directValue!,
    "--request-patch or AGENT_OPENAI_REQUEST_PATCH"
  );
}
