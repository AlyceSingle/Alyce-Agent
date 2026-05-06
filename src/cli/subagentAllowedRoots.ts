import os from "node:os";
import path from "node:path";

interface SubagentAllowedRootsSettings {
  additionalDirectories: readonly string[];
}

interface SubagentAllowedRootsPolicy {
  allowedRoots?: readonly string[];
}

export function resolveSubagentAllowedRoots(
  workspaceRoot: string,
  agent: { policy: SubagentAllowedRootsPolicy },
  settings: SubagentAllowedRootsSettings,
  sessionAdditionalDirectories: readonly string[]
): string[] {
  if (!agent.policy.allowedRoots?.length) {
    return resolveAllowedRoots(workspaceRoot, settings, sessionAdditionalDirectories);
  }

  const deduped = new Set<string>();
  for (const directory of agent.policy.allowedRoots) {
    const normalized = directory.trim();
    if (!normalized) {
      continue;
    }

    deduped.add(resolveDirectoryInput(normalized, workspaceRoot));
  }

  return [...deduped];
}

function resolveAllowedRoots(
  workspaceRoot: string,
  settings: SubagentAllowedRootsSettings,
  sessionAdditionalDirectories: readonly string[]
): string[] {
  const deduped = new Set<string>([path.resolve(workspaceRoot)]);
  for (const directory of settings.additionalDirectories) {
    deduped.add(resolveDirectoryInput(directory, workspaceRoot));
  }
  for (const directory of sessionAdditionalDirectories) {
    deduped.add(resolveDirectoryInput(directory, workspaceRoot));
  }

  return [...deduped];
}

function resolveDirectoryInput(directory: string, workspaceRoot: string): string {
  const normalized = directory.trim();
  if (normalized === "~") {
    return path.resolve(os.homedir());
  }

  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), normalized.slice(2)));
  }

  return path.resolve(workspaceRoot, normalized);
}
