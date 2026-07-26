import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveReadablePathWithExternalApproval } from "../internal/externalDirectoryAccess.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import type { ToolExecutionContext } from "../types.js";
import { FILE_READ_TOOL_NAME } from "./prompt.js";

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2"
]);

const WINDOWS_BLOCKED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$"
]);

export async function resolveReadPath(
  filePath: string,
  context: ToolExecutionContext
): Promise<string> {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("Read requires non-empty 'file_path'");
  }

  const resolved = await resolveReadablePathWithExternalApproval(context, normalized, {
    toolName: FILE_READ_TOOL_NAME,
    title: "Read external path",
    kind: "file-or-directory"
  });
  return resolved.absolutePath;
}

export function assertReadablePathCandidate(absolutePath: string) {
  if (isBlockedDevicePath(absolutePath)) {
    throw new Error(`Read cannot open ${absolutePath} because this device path would block or stream endlessly.`);
  }
}

function isBlockedDevicePath(absolutePath: string) {
  if (isWindowsDevicePath(absolutePath)) {
    return true;
  }

  if (BLOCKED_DEVICE_PATHS.has(absolutePath)) {
    return true;
  }

  return (
    absolutePath.startsWith("/proc/") &&
    (absolutePath.endsWith("/fd/0") ||
      absolutePath.endsWith("/fd/1") ||
      absolutePath.endsWith("/fd/2"))
  );
}

function isWindowsDevicePath(absolutePath: string) {
  if (process.platform !== "win32") {
    return false;
  }

  const basename = path.basename(absolutePath).replace(/[. ]+$/g, "");
  const deviceName = basename.split(".")[0]?.toUpperCase() ?? "";
  return (
    WINDOWS_BLOCKED_DEVICE_NAMES.has(deviceName) ||
    /^COM[1-9]$/.test(deviceName) ||
    /^LPT[1-9]$/.test(deviceName)
  );
}

export async function statReadPath(absolutePath: string, workspaceRoot: string) {
  try {
    return await fs.stat(absolutePath);
  } catch (error) {
    if (isEnoentError(error)) {
      throw new Error(await buildMissingPathMessage(absolutePath, workspaceRoot));
    }

    throw error;
  }
}

async function buildMissingPathMessage(absolutePath: string, workspaceRoot: string) {
  const suggestions = await findPathSuggestions(absolutePath, workspaceRoot);
  const missingPath = toWorkspaceRelative(workspaceRoot, absolutePath);
  if (suggestions.length === 0) {
    return `Path not found: ${missingPath}`;
  }

  return `Path not found: ${missingPath}\n\nDid you mean one of these?\n${suggestions
    .map((suggestion) => `- ${suggestion}`)
    .join("\n")}`;
}

async function findPathSuggestions(absolutePath: string, workspaceRoot: string) {
  const nearestDirectory = await findNearestExistingDirectory(path.dirname(absolutePath));
  if (!nearestDirectory) {
    return [];
  }

  const targetBase = path.basename(absolutePath).toLowerCase();
  try {
    const entries = await fs.readdir(nearestDirectory, { withFileTypes: true });
    return entries
      .map((entry) => ({
        label: entry.isDirectory() ? `${entry.name}/` : entry.name,
        absolute: path.join(nearestDirectory, entry.name),
        score: scorePathSuggestion(targetBase, entry.name.toLowerCase())
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
      .slice(0, 3)
      .map((entry) => {
        const display = toWorkspaceRelative(workspaceRoot, entry.absolute);
        return entry.label.endsWith("/") && !display.endsWith("/") ? `${display}/` : display;
      });
  } catch {
    return [];
  }
}

async function findNearestExistingDirectory(directoryPath: string): Promise<string | null> {
  let currentPath = path.resolve(directoryPath);

  while (true) {
    try {
      const stats = await fs.stat(currentPath);
      if (stats.isDirectory()) {
        return currentPath;
      }
    } catch {}

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

function scorePathSuggestion(targetBase: string, candidate: string) {
  if (!targetBase || !candidate) {
    return 0;
  }

  if (candidate === targetBase) {
    return 100;
  }

  if (candidate.startsWith(targetBase) || targetBase.startsWith(candidate)) {
    return 80;
  }

  if (candidate.includes(targetBase) || targetBase.includes(candidate)) {
    return 60;
  }

  const targetStem = stripExtension(targetBase);
  const candidateStem = stripExtension(candidate);
  if (
    targetStem.length > 0 &&
    candidateStem.length > 0 &&
    (candidateStem.includes(targetStem) || targetStem.includes(candidateStem))
  ) {
    return 40;
  }

  return 0;
}

function stripExtension(value: string) {
  const extension = path.extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function isEnoentError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
