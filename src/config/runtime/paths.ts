import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProjectTrustKey } from "../../core/trust/projectTrustStore.js";
import { logStartupTiming } from "../../core/startup/startupTiming.js";
import type {
  RuntimeBootstrapFailure,
  RuntimeBootstrapReport,
  RuntimePaths
} from "./types.js";
import { isMissingFileError } from "./shared.js";

export function getRuntimePaths(workspaceRoot: string): RuntimePaths {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const projectAlyceDirectory = path.join(resolvedWorkspaceRoot, ".alyce");
  const userAlyceDirectory = path.join(os.homedir(), ".alyce");
  const workspaceRuntimeDirectory = path.join(
    userAlyceDirectory,
    "workspace-state",
    getProjectTrustKey(resolvedWorkspaceRoot)
  );

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    projectAlyceDirectory,
    alyceDirectory: workspaceRuntimeDirectory,
    connectionConfigPath: path.join(projectAlyceDirectory, "config.json"),
    settingsConfigPath: path.join(projectAlyceDirectory, "settings.json"),
    projectSkillsDirectory: path.join(projectAlyceDirectory, "skills"),
    projectAgentsDirectory: path.join(projectAlyceDirectory, "agents"),
    projectPluginsDirectory: path.join(projectAlyceDirectory, "plugins"),
    userAlyceDirectory,
    userConnectionConfigPath: path.join(userAlyceDirectory, "config.json"),
    userSettingsConfigPath: path.join(userAlyceDirectory, "settings.json"),
    userSkillsDirectory: path.join(userAlyceDirectory, "skills"),
    userPluginsDirectory: path.join(userAlyceDirectory, "plugins"),
    workspaceRuntimeDirectory,
    memoryDirectory: path.join(workspaceRuntimeDirectory, "memory"),
    sessionsDirectory: path.join(workspaceRuntimeDirectory, "sessions"),
    backgroundProcessesDirectory: path.join(workspaceRuntimeDirectory, "background-processes"),
    mcpOutputDirectory: path.join(workspaceRuntimeDirectory, "mcp-output"),
    snapshotsDirectory: path.join(workspaceRuntimeDirectory, "snapshots"),
    gitSnapshotsDirectory: path.join(workspaceRuntimeDirectory, "snapshots", "git"),
    fileHistoryDirectory: path.join(workspaceRuntimeDirectory, "file-history"),
    tasksDirectory: path.join(workspaceRuntimeDirectory, "tasks"),
    usageLogPath: path.join(workspaceRuntimeDirectory, "usage.jsonl"),
    projectTrustStorePath: path.join(userAlyceDirectory, "trusted-projects.json")
  };
}

export async function ensureRuntimeStoragePaths(paths: RuntimePaths): Promise<RuntimeBootstrapReport> {
  const createdPaths: string[] = [];
  const existingPaths: string[] = [];
  const failedPaths: RuntimeBootstrapFailure[] = [];

  // 所有目录创建操作互不依赖，并行执行以加速启动。
  const results = await Promise.all(
    getRuntimeBootstrapDirectories(paths).map(async (directory) => {
      logStartupTiming("runtime:ensureStoragePath:start", { directory });
      try {
        const stat = await fs.stat(directory);
        if (!stat.isDirectory()) {
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "failed-not-directory"
          });
          return { type: "failed" as const, path: directory, error: "path exists but is not a directory" };
        }

        logStartupTiming("runtime:ensureStoragePath:end", {
          directory,
          status: "existing"
        });
        return { type: "existing" as const, path: directory };
      } catch (error) {
        if (!isMissingFileError(error)) {
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "failed-stat"
          });
          return { type: "failed" as const, path: directory, error: error instanceof Error ? error.message : String(error) };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "created"
          });
          return { type: "created" as const, path: directory };
        } catch (mkdirError) {
          logStartupTiming("runtime:ensureStoragePath:end", {
            directory,
            status: "failed-mkdir"
          });
          return { type: "failed" as const, path: directory, error: mkdirError instanceof Error ? mkdirError.message : String(mkdirError) };
        }
      }
    })
  );

  for (const result of results) {
    if (result.type === "failed") {
      failedPaths.push({ path: result.path, error: result.error });
    } else if (result.type === "created") {
      createdPaths.push(result.path);
    } else {
      existingPaths.push(result.path);
    }
  }

  return {
    createdPaths,
    existingPaths,
    failedPaths,
    firstRun: createdPaths.includes(paths.userAlyceDirectory) ||
      createdPaths.includes(paths.workspaceRuntimeDirectory)
  };
}

function getRuntimeBootstrapDirectories(paths: RuntimePaths): string[] {
  return [
    paths.userAlyceDirectory,
    paths.userSkillsDirectory,
    paths.userPluginsDirectory,
    paths.workspaceRuntimeDirectory,
    paths.memoryDirectory,
    paths.sessionsDirectory,
    paths.backgroundProcessesDirectory,
    paths.mcpOutputDirectory,
    paths.gitSnapshotsDirectory,
    paths.fileHistoryDirectory,
    paths.tasksDirectory
  ];
}

export function resolveDirectoryInput(directory: string, workspaceRoot: string): string {
  const normalized = directory.trim();
  if (normalized === "~") {
    return path.resolve(os.homedir());
  }

  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), normalized.slice(2)));
  }

  return path.resolve(workspaceRoot, normalized);
}
