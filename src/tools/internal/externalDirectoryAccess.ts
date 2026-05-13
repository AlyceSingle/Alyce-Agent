import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolExecutionContext } from "../types.js";
import {
  isPathAllowed,
  normalizeAllowedRoots,
  resolvePathFromInput,
  resolvePathFromInputUnchecked
} from "./pathSandbox.js";

export type ReadablePathKind = "file" | "directory" | "file-or-directory";
export type WritablePathKind = ReadablePathKind;

export interface ExternalPathResolution {
  absolutePath: string;
  allowedRoots: string[];
}

export type ExternalReadablePathResolution = ExternalPathResolution;
export type ExternalWritablePathResolution = ExternalPathResolution;

export async function resolveReadablePathWithExternalApproval(
  context: ToolExecutionContext,
  inputPath: string,
  options: {
    toolName: string;
    title?: string;
    kind?: ReadablePathKind;
    currentAllowedRoots?: readonly string[];
  }
): Promise<ExternalReadablePathResolution> {
  return resolvePathWithExternalApproval(context, inputPath, {
    toolName: options.toolName,
    title: options.title ?? "Access external directory",
    kind: options.kind ?? "file-or-directory",
    currentAllowedRoots: options.currentAllowedRoots,
    accessLabel: "read/search only"
  });
}

export async function resolveWritablePathWithExternalApproval(
  context: ToolExecutionContext,
  inputPath: string,
  options: {
    toolName: string;
    title?: string;
    kind?: WritablePathKind;
    currentAllowedRoots?: readonly string[];
  }
): Promise<ExternalWritablePathResolution> {
  return resolvePathWithExternalApproval(context, inputPath, {
    toolName: options.toolName,
    title: options.title ?? "Access external directory",
    kind: options.kind ?? "file",
    currentAllowedRoots: options.currentAllowedRoots,
    accessLabel: "read/write"
  });
}

async function resolvePathWithExternalApproval(
  context: ToolExecutionContext,
  inputPath: string,
  options: {
    toolName: string;
    title: string;
    kind: ReadablePathKind;
    currentAllowedRoots?: readonly string[];
    accessLabel: string;
  }
): Promise<ExternalPathResolution> {
  const normalizedPath = inputPath.trim();
  if (!normalizedPath) {
    throw new Error("Path must not be empty");
  }

  const currentAllowedRoots = normalizeAllowedRoots(options.currentAllowedRoots ?? context.allowedRoots);
  const absolutePath = resolvePathFromInputUnchecked(context.workspaceRoot, normalizedPath);
  if (isPathAllowed(currentAllowedRoots, absolutePath)) {
    return {
      absolutePath: resolvePathFromInput(context.workspaceRoot, currentAllowedRoots, normalizedPath),
      allowedRoots: currentAllowedRoots
    };
  }

  const externalDirectory = await resolveExternalDirectoryScope(
    absolutePath,
    options.kind
  );
  const approved = await context.requestApproval({
    kind: "external-directory",
    toolName: options.toolName,
    title: options.title,
    summary: externalDirectory,
    details: [
      `Requested path: ${absolutePath}`,
      `Directory scope: ${externalDirectory}`,
      `Access: ${options.accessLabel}`
    ],
    scope: {
      type: "external-directory",
      directory: externalDirectory
    },
    permission: {
      permission: "directory.external",
      pattern: externalDirectory
    }
  });

  if (!approved) {
    throw new Error(`User rejected external directory access: ${externalDirectory}`);
  }

  return {
    absolutePath,
    allowedRoots: normalizeAllowedRoots([...currentAllowedRoots, externalDirectory])
  };
}

async function resolveExternalDirectoryScope(
  absolutePath: string,
  kind: ReadablePathKind
): Promise<string> {
  if (kind === "directory") {
    return path.resolve(absolutePath);
  }

  if (kind === "file") {
    return path.dirname(path.resolve(absolutePath));
  }

  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      return path.resolve(absolutePath);
    }
  } catch {
    // Missing paths still request the nearest intended parent directory.
  }

  return path.dirname(path.resolve(absolutePath));
}
