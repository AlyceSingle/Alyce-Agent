import path from "node:path";
import os from "node:os";
import type { CommandSafetyAnalysis } from "./commandSafety.js";
import type { ToolExecutionContext } from "../types.js";

export async function capturePossibleCommandWritePaths(options: {
  analysis: CommandSafetyAnalysis;
  context: ToolExecutionContext;
  workingDirectory: string;
}) {
  const captured = new Set<string>();
  for (const inputPath of options.analysis.possibleWritePaths) {
    const absolutePath = resolveCommandWritePath(inputPath, options.workingDirectory);
    const key = normalizePathKey(absolutePath);
    if (captured.has(key)) {
      continue;
    }

    captured.add(key);
    await options.context.captureFileBeforeWrite(absolutePath);
  }
}

function resolveCommandWritePath(inputPath: string, workingDirectory: string) {
  const normalized = inputPath.trim();
  const expanded = expandHomePath(normalized);

  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workingDirectory, expanded);
}

function normalizePathKey(absolutePath: string) {
  const resolved = path.resolve(absolutePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expandHomePath(inputPath: string) {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}
