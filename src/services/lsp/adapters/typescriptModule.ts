import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import semver from "semver";
import type tsNamespace from "typescript";

export type TypeScriptModule = typeof tsNamespace;

export type TypeScriptModuleSource = "workspace" | "bundled";

export interface TypeScriptResolutionInfo {
  source: TypeScriptModuleSource;
  version: string | null;
  supported: boolean;
  modulePath: string;
}

export interface LoadedTypeScript {
  module: TypeScriptModule;
  source: TypeScriptModuleSource;
  version: string | null;
  modulePath: string;
}

export const MIN_SUPPORTED_TYPESCRIPT_VERSION = "5.0.0";

let cachedLoadResult: LoadedTypeScript | null | undefined;

// Resolution is metadata-only (package.json), so callers like /doctor can
// report the backend without paying the cost of loading the compiler.
export function describeTypeScriptResolution(
  workspaceRoot: string = process.cwd()
): TypeScriptResolutionInfo | null {
  const candidates: TypeScriptResolutionInfo[] = [];

  const workspaceCandidate = resolveCandidate(
    () => createRequire(path.join(workspaceRoot, "package.json")),
    "workspace"
  );
  if (workspaceCandidate) {
    candidates.push(workspaceCandidate);
  }

  const bundledCandidate = resolveCandidate(() => createRequire(import.meta.url), "bundled");
  if (bundledCandidate) {
    candidates.push(bundledCandidate);
  }

  return candidates.find((candidate) => candidate.supported) ?? candidates[0] ?? null;
}

export function loadTypeScriptModule(
  workspaceRoot: string = process.cwd()
): LoadedTypeScript | null {
  if (cachedLoadResult !== undefined) {
    return cachedLoadResult;
  }

  cachedLoadResult = loadFromResolution(describeTypeScriptResolution(workspaceRoot));
  return cachedLoadResult;
}

export function resetTypeScriptModuleCacheForTests(): void {
  cachedLoadResult = undefined;
}

function loadFromResolution(
  resolution: TypeScriptResolutionInfo | null
): LoadedTypeScript | null {
  if (!resolution || !resolution.supported) {
    return null;
  }

  let module: TypeScriptModule;
  try {
    const requireFromHere = createRequire(import.meta.url);
    module = requireFromHere(resolution.modulePath) as TypeScriptModule;
  } catch {
    return null;
  }

  return {
    module,
    source: resolution.source,
    version: resolution.version,
    modulePath: resolution.modulePath
  };
}

function resolveCandidate(
  createRequireForBase: () => NodeRequire,
  source: TypeScriptModuleSource
): TypeScriptResolutionInfo | null {
  let requireFromBase: NodeRequire;
  try {
    requireFromBase = createRequireForBase();
  } catch {
    return null;
  }

  try {
    const modulePath = requireFromBase.resolve("typescript");
    const packageJson = requireFromBase("typescript/package.json") as { version?: unknown };
    const version = typeof packageJson.version === "string" ? packageJson.version : null;
    return {
      source,
      version,
      supported: version !== null && semver.gte(version, MIN_SUPPORTED_TYPESCRIPT_VERSION),
      modulePath
    };
  } catch {
    return null;
  }
}
