import { promises as fs } from "node:fs";
import type OpenAI from "openai";
import { createStartupContextMessage } from "../core/api/generatedMessages.js";
import {
  normalizeAllowedRoots,
  resolvePathFromInput,
  toWorkspaceRelative
} from "../tools/internal/pathSandbox.js";

type UserMessageParam = OpenAI.Chat.Completions.ChatCompletionUserMessageParam;

export interface StartupContextFile {
  kind: "context" | "selection" | "prompt";
  inputPath: string;
  absolutePath: string;
  displayPath: string;
  content: string;
}

export interface StartupContext {
  initialPrompt?: string;
  contextMessage?: UserMessageParam;
  summary?: string;
  files: StartupContextFile[];
}

export interface LoadStartupContextOptions {
  workspaceRoot: string;
  allowedRoots: readonly string[];
}

interface ParsedStartupArgs {
  contextFiles: string[];
  selectionFiles: string[];
  initialPrompt?: string;
  promptFile?: string;
}

export async function loadStartupContextFromArgs(
  argv: readonly string[],
  options: LoadStartupContextOptions
): Promise<StartupContext> {
  const parsed = parseStartupContextArgs(argv);
  const allowedRoots = normalizeAllowedRoots(options.allowedRoots);
  const files = [
    ...(await Promise.all(parsed.contextFiles.map((inputPath) =>
      readStartupContextFile("context", inputPath, {
        ...options,
        allowedRoots
      })
    ))),
    ...(await Promise.all(parsed.selectionFiles.map((inputPath) =>
      readStartupContextFile("selection", inputPath, {
        ...options,
        allowedRoots
      })
    )))
  ];
  const initialPrompt = await resolveInitialPrompt(parsed, {
    ...options,
    allowedRoots
  });
  const contextMessage = files.length > 0
    ? createStartupContextMessage(formatStartupContextMessage(files))
    : undefined;

  return {
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(contextMessage ? { contextMessage } : {}),
    ...(files.length > 0 || initialPrompt
      ? { summary: formatStartupContextSummary(files, initialPrompt) }
      : {}),
    files
  };
}

export function parseStartupContextArgs(argv: readonly string[]): ParsedStartupArgs {
  const parsed: ParsedStartupArgs = {
    contextFiles: [],
    selectionFiles: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--context-file") {
      parsed.contextFiles.push(readFlagValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--selection-file") {
      parsed.selectionFiles.push(readFlagValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--initial-prompt") {
      parsed.initialPrompt = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--prompt-file") {
      parsed.promptFile = readFlagValue(argv, index, arg);
      index += 1;
    }
  }

  if (parsed.initialPrompt !== undefined && parsed.promptFile !== undefined) {
    throw new Error("Cannot use --initial-prompt and --prompt-file at the same time.");
  }

  return parsed;
}

async function resolveInitialPrompt(
  parsed: ParsedStartupArgs,
  options: LoadStartupContextOptions
): Promise<string | undefined> {
  const directPrompt = normalizeOptionalText(parsed.initialPrompt);
  if (directPrompt !== undefined) {
    return directPrompt;
  }

  if (!parsed.promptFile) {
    return undefined;
  }

  const promptFile = await readStartupContextFile("prompt", parsed.promptFile, options);
  return normalizeOptionalText(promptFile.content);
}

async function readStartupContextFile(
  kind: StartupContextFile["kind"],
  inputPath: string,
  options: LoadStartupContextOptions
): Promise<StartupContextFile> {
  const absolutePath = resolvePathFromInput(
    options.workspaceRoot,
    options.allowedRoots,
    inputPath
  );

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Startup ${kind} file does not exist: ${absolutePath}`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to inspect startup ${kind} file: ${absolutePath}. ${message}`);
  }

  if (!stats.isFile()) {
    throw new Error(`Startup ${kind} path must be a file: ${absolutePath}`);
  }

  let content: string;
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read startup ${kind} file: ${absolutePath}. ${message}`);
  }

  return {
    kind,
    inputPath,
    absolutePath,
    displayPath: toWorkspaceRelative(options.workspaceRoot, absolutePath),
    content
  };
}

function formatStartupContextMessage(files: StartupContextFile[]) {
  const lines = [
    "# Startup Context",
    "",
    "The following content was explicitly supplied through Alyce startup CLI arguments.",
    "Use it as context for the next user prompt. Do not assume Alyce has read the rest of the workspace.",
    ""
  ];

  for (const file of files) {
    lines.push(
      file.kind === "selection"
        ? "## Selection File"
        : file.kind === "prompt"
          ? "## Prompt File"
          : "## Context File",
      `Path: ${file.displayPath}`,
      "",
      "```text",
      file.content.replace(/\r\n/g, "\n").trimEnd(),
      "```",
      ""
    );
  }

  return lines.join("\n").trimEnd();
}

function formatStartupContextSummary(
  files: StartupContextFile[],
  initialPrompt: string | undefined
): string {
  const lines = ["Startup context loaded."];
  for (const file of files) {
    lines.push(`- ${formatStartupFileKind(file.kind)}: ${file.displayPath}`);
  }
  if (initialPrompt) {
    lines.push("- Initial prompt: prefilled in the input box");
  }

  return lines.join("\n");
}

function formatStartupFileKind(kind: StartupContextFile["kind"]): string {
  switch (kind) {
    case "selection":
      return "Selection";
    case "prompt":
      return "Prompt";
    case "context":
    default:
      return "Context";
  }
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\r\n/g, "\n").trim();
  return normalized ? normalized : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
