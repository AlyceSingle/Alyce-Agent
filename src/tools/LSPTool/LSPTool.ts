import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { throwIfAborted } from "../../core/abort.js";
import { resolvePathFromInput, isPathAllowed, toWorkspaceRelative } from "../internal/pathSandbox.js";
import { truncate } from "../internal/values.js";
import type { ToolExecutionContext } from "../types.js";
import { DESCRIPTION, LSP_TOOL_NAME } from "./prompt.js";
import {
  LSPToolInputSchema,
  LSPToolOutputSchema,
  type LSPToolInput,
  type LSPToolResult
} from "./schemas.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs"
]);
const DEFAULT_MAX_WORKSPACE_SYMBOLS = 100;
const MAX_FORMATTED_ITEMS = 200;
const MAX_CALL_SITE_LOCATIONS = 20;

type TypeScriptProject = {
  service: ts.LanguageService;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  fileName: string;
  sourceFile: ts.SourceFile;
  sys: RestrictedTypeScriptSystem;
};

type RestrictedTypeScriptSystem = {
  useCaseSensitiveFileNames: boolean;
  fileExists: (fileName: string) => boolean;
  readFile: (fileName: string, encoding?: string) => string | undefined;
  readDirectory: (
    rootDir: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
    includes?: readonly string[],
    depth?: number
  ) => string[];
  directoryExists: (directoryName: string) => boolean;
  getDirectories: (directoryName: string) => string[];
  realpath: (fileName: string) => string;
};

type SpanLike = {
  fileName: string;
  textSpan: ts.TextSpan;
  kind?: string;
  name?: string;
  containerName?: string;
  isDefinition?: boolean;
};

export const LSPInputSchema = LSPToolInputSchema;
export const LSPOutputSchema = LSPToolOutputSchema;
export type { LSPToolInput, LSPToolResult };
export { LSP_TOOL_NAME, DESCRIPTION as LSP_TOOL_DESCRIPTION };

export async function executeLSPTool(
  input: LSPToolInput,
  context: ToolExecutionContext
): Promise<LSPToolResult> {
  throwIfAborted(context.abortSignal);

  const absolutePath = resolvePathFromInput(
    context.workspaceRoot,
    context.allowedRoots,
    input.filePath
  );
  assertSupportedFile(absolutePath);
  assertRegularFile(absolutePath, context.allowedRoots);

  const project = createTypeScriptProject({
    fileName: absolutePath,
    workspaceRoot: context.workspaceRoot,
    allowedRoots: context.allowedRoots
  });

  let result: Pick<LSPToolResult, "result" | "resultCount" | "fileCount">;
  switch (input.operation) {
    case "goToDefinition":
      result = runGoToDefinition(project, getRequiredPosition(project, input));
      break;
    case "findReferences":
      result = runFindReferences(project, getRequiredPosition(project, input));
      break;
    case "hover":
      result = runHover(project, getRequiredPosition(project, input));
      break;
    case "documentSymbol":
      result = runDocumentSymbol(project);
      break;
    case "workspaceSymbol":
      result = runWorkspaceSymbol(project, input.query, input.maxResults);
      break;
    case "goToImplementation":
      result = runGoToImplementation(project, getRequiredPosition(project, input));
      break;
    case "prepareCallHierarchy":
      result = runPrepareCallHierarchy(project, getRequiredPosition(project, input));
      break;
    case "incomingCalls":
      result = runIncomingCalls(project, getRequiredPosition(project, input));
      break;
    case "outgoingCalls":
      result = runOutgoingCalls(project, getRequiredPosition(project, input));
      break;
  }

  return {
    operation: input.operation,
    filePath: toWorkspaceRelative(context.workspaceRoot, absolutePath),
    backend: "typescript-language-service",
    ...result
  };
}

function getRequiredPosition(project: TypeScriptProject, input: LSPToolInput) {
  if (input.line === undefined || input.character === undefined) {
    throw new Error(`${input.operation} requires both line and character.`);
  }

  return getPosition(project.sourceFile, input.line, input.character);
}

function createTypeScriptProject(options: {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
}): TypeScriptProject {
  const sys = createRestrictedTypeScriptSystem(options.allowedRoots);
  const config = loadCompilerConfig(options.fileName, options.allowedRoots, sys);
  const rootFileNames = ensureRootFile(config.fileNames, options.fileName, options.allowedRoots);
  const sourceVersions = new Map<string, string>();

  for (const fileName of rootFileNames) {
    sourceVersions.set(normalizeFileName(fileName), getFileVersion(fileName, options.allowedRoots));
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => config.options,
    getCurrentDirectory: () => config.currentDirectory,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getScriptFileNames: () => rootFileNames,
    getScriptSnapshot: (fileName) => {
      const content = sys.readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getScriptVersion: (fileName) =>
      sourceVersions.get(normalizeFileName(fileName)) ??
      getFileVersion(fileName, options.allowedRoots),
    fileExists: sys.fileExists,
    readDirectory: sys.readDirectory,
    readFile: sys.readFile,
    directoryExists: sys.directoryExists,
    getDirectories: sys.getDirectories,
    realpath: sys.realpath,
    useCaseSensitiveFileNames: () => sys.useCaseSensitiveFileNames
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();
  const sourceFile = program?.getSourceFile(options.fileName);
  if (!sourceFile) {
    throw new Error(`Unable to load file in TypeScript language service: ${options.fileName}`);
  }

  return {
    service,
    workspaceRoot: options.workspaceRoot,
    allowedRoots: options.allowedRoots,
    fileName: options.fileName,
    sourceFile,
    sys
  };
}

function loadCompilerConfig(
  fileName: string,
  allowedRoots: readonly string[],
  sys: RestrictedTypeScriptSystem
) {
  const configPath = ts.findConfigFile(path.dirname(fileName), sys.fileExists, "tsconfig.json");
  if (configPath && isAllowedExistingPath(allowedRoots, configPath)) {
    const read = ts.readConfigFile(configPath, sys.readFile);
    if (read.error) {
      throw new Error(formatDiagnostic(read.error));
    }

    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      sys,
      path.dirname(configPath),
      undefined,
      configPath
    );
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
    }

    return {
      currentDirectory: path.dirname(configPath),
      fileNames: parsed.fileNames,
      options: parsed.options
    };
  }

  return {
    currentDirectory: path.dirname(fileName),
    fileNames: [fileName],
    options: {
      allowJs: true,
      checkJs: false,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022
    } satisfies ts.CompilerOptions
  };
}

function ensureRootFile(fileNames: string[], fileName: string, allowedRoots: readonly string[]) {
  const normalizedTarget = normalizeFileName(fileName);
  const filtered = fileNames.filter((candidate) => isAllowedExistingPath(allowedRoots, candidate));
  if (!filtered.some((candidate) => normalizeFileName(candidate) === normalizedTarget)) {
    filtered.push(fileName);
  }

  return filtered;
}

function runGoToDefinition(project: TypeScriptProject, position: number) {
  const definitions = project.service.getDefinitionAtPosition(project.fileName, position) ?? [];
  return formatSpans(project, definitions, {
    empty: "No definition found. The cursor may not be on a symbol, or the symbol may come from an unindexed external library.",
    singular: "definition",
    plural: "definitions"
  });
}

function runFindReferences(project: TypeScriptProject, position: number) {
  const references = project.service.findReferences(project.fileName, position) ?? [];
  const spans = references.flatMap((symbol) =>
    symbol.references.map((reference) => ({
      ...reference,
      name: symbol.definition?.name,
      kind: symbol.definition?.kind
    }))
  );
  return formatSpans(project, spans, {
    empty: "No references found. The symbol may have no usages, or the project may not be fully indexed.",
    singular: "reference",
    plural: "references"
  });
}

function runHover(project: TypeScriptProject, position: number) {
  const info = project.service.getQuickInfoAtPosition(project.fileName, position);
  if (!info) {
    return {
      result: "No hover information available. The cursor may not be on a symbol.",
      resultCount: 0,
      fileCount: 0
    };
  }

  const display = ts.displayPartsToString(info.displayParts);
  const documentation = ts.displayPartsToString(info.documentation);
  const tags = (info.tags ?? [])
    .map((tag) => {
      const text = typeof tag.text === "string" ? tag.text : ts.displayPartsToString(tag.text);
      return text ? `@${tag.name} ${text}` : `@${tag.name}`;
    })
    .filter((tag) => tag.length > 0);
  const lines = [display, documentation, ...tags].filter((line) => line.trim().length > 0);

  return {
    result: truncate(lines.length > 0 ? lines.join("\n\n") : "Hover information is empty."),
    resultCount: 1,
    fileCount: 1
  };
}

function runDocumentSymbol(project: TypeScriptProject) {
  const tree = project.service.getNavigationTree(project.fileName);
  const children = tree.childItems ?? [];
  const resultCount = countNavigationNodes(children);
  if (children.length === 0) {
    return {
      result: "No symbols found in document.",
      resultCount: 0,
      fileCount: 0
    };
  }

  const lines = ["Document symbols:"];
  const budget = createFormatBudget();
  for (const child of children) {
    lines.push(...formatNavigationNode(project, child, 0, budget));
    if (budget.truncated) {
      break;
    }
  }
  appendLimitNotice(lines, resultCount, budget.formattedCount, "symbols");

  return {
    result: truncate(lines.join("\n")),
    resultCount,
    fileCount: 1
  };
}

function runWorkspaceSymbol(project: TypeScriptProject, query: string | undefined, maxResults: number | undefined) {
  const limit = maxResults ?? DEFAULT_MAX_WORKSPACE_SYMBOLS;
  const symbols = project.service
    .getNavigateToItems(query ?? "", limit, undefined, true, true)
    .filter((symbol) => isAllowedExistingPath(project.allowedRoots, symbol.fileName));

  if (symbols.length === 0) {
    return {
      result: query
        ? `No workspace symbols found for "${query}".`
        : "No workspace symbols found.",
      resultCount: 0,
      fileCount: 0
    };
  }

  const displaySymbols = takeFormattedItems(symbols);
  const totalGroups = groupByFile(symbols).size;
  const grouped = groupByFile(displaySymbols);
  const lines = [
    `Found ${symbols.length} ${plural(symbols.length, "symbol")} across ${totalGroups} ${plural(totalGroups, "file")}:`
  ];
  for (const [fileName, items] of grouped) {
    lines.push("", `${formatPath(project.workspaceRoot, fileName)}:`);
    for (const item of items) {
      const location = getLineAndCharacter(project, item.fileName, item.textSpan.start);
      const container = item.containerName ? ` in ${item.containerName}` : "";
      lines.push(`  ${item.name} (${formatKind(item.kind)}) - Line ${location.line}${container}`);
    }
  }
  appendLimitNotice(lines, symbols.length, displaySymbols.length, "symbols");

  return {
    result: truncate(lines.join("\n")),
    resultCount: symbols.length,
    fileCount: totalGroups
  };
}

function runGoToImplementation(project: TypeScriptProject, position: number) {
  const implementations = project.service.getImplementationAtPosition(project.fileName, position) ?? [];
  return formatSpans(project, implementations, {
    empty: "No implementation found. This usually happens when the symbol is not an interface, abstract method, or overridden declaration.",
    singular: "implementation",
    plural: "implementations"
  });
}

function runPrepareCallHierarchy(project: TypeScriptProject, position: number) {
  const prepared = project.service.prepareCallHierarchy(project.fileName, position);
  const items = normalizeArray(prepared).filter((item) =>
    isAllowedExistingPath(project.allowedRoots, item.file)
  );
  if (items.length === 0) {
    return {
      result: "No call hierarchy item found at this position.",
      resultCount: 0,
      fileCount: 0
    };
  }

  const displayItems = takeFormattedItems(items);
  const lines = [
    `Found ${items.length} call ${plural(items.length, "item")}:`,
    ...displayItems.map((item) => `  ${formatCallItem(project, item)}`)
  ];
  appendLimitNotice(lines, items.length, displayItems.length, "items");

  return {
    result: truncate(lines.join("\n")),
    resultCount: items.length,
    fileCount: countUnique(items.map((item) => item.file))
  };
}

function runIncomingCalls(project: TypeScriptProject, position: number) {
  const calls = project.service
    .provideCallHierarchyIncomingCalls(project.fileName, position)
    .filter((call) => isAllowedExistingPath(project.allowedRoots, call.from.file));
  if (calls.length === 0) {
    return {
      result: "No incoming calls found.",
      resultCount: 0,
      fileCount: 0
    };
  }

  const displayCalls = takeFormattedItems(calls);
  const totalGroups = groupByFile(calls, (call) => call.from.file).size;
  const grouped = groupByFile(displayCalls, (call) => call.from.file);
  const lines = [`Found ${calls.length} incoming ${plural(calls.length, "call")}:`];
  for (const [fileName, items] of grouped) {
    lines.push("", `${formatPath(project.workspaceRoot, fileName)}:`);
    for (const call of items) {
      const location = getLineAndCharacter(project, call.from.file, call.from.selectionSpan.start);
      const sites = formatCallSites(project, call.from.file, call.fromSpans);
      lines.push(
        `  ${call.from.name} (${formatKind(call.from.kind)}) - Line ${location.line}${sites.length ? ` [calls at: ${sites.join(", ")}]` : ""}`
      );
    }
  }
  appendLimitNotice(lines, calls.length, displayCalls.length, "calls");

  return {
    result: truncate(lines.join("\n")),
    resultCount: calls.length,
    fileCount: totalGroups
  };
}

function runOutgoingCalls(project: TypeScriptProject, position: number) {
  const calls = project.service
    .provideCallHierarchyOutgoingCalls(project.fileName, position)
    .filter((call) => isAllowedExistingPath(project.allowedRoots, call.to.file));
  if (calls.length === 0) {
    return {
      result: "No outgoing calls found.",
      resultCount: 0,
      fileCount: 0
    };
  }

  const displayCalls = takeFormattedItems(calls);
  const totalGroups = groupByFile(calls, (call) => call.to.file).size;
  const grouped = groupByFile(displayCalls, (call) => call.to.file);
  const lines = [`Found ${calls.length} outgoing ${plural(calls.length, "call")}:`];
  for (const [fileName, items] of grouped) {
    lines.push("", `${formatPath(project.workspaceRoot, fileName)}:`);
    for (const call of items) {
      const location = getLineAndCharacter(project, call.to.file, call.to.selectionSpan.start);
      const sites = formatCallSites(project, project.fileName, call.fromSpans);
      lines.push(
        `  ${call.to.name} (${formatKind(call.to.kind)}) - Line ${location.line}${sites.length ? ` [called from: ${sites.join(", ")}]` : ""}`
      );
    }
  }
  appendLimitNotice(lines, calls.length, displayCalls.length, "calls");

  return {
    result: truncate(lines.join("\n")),
    resultCount: calls.length,
    fileCount: totalGroups
  };
}

function formatSpans(
  project: TypeScriptProject,
  spans: readonly SpanLike[],
  labels: { empty: string; singular: string; plural: string }
) {
  const allowedSpans = spans.filter((span) =>
    isAllowedExistingPath(project.allowedRoots, span.fileName)
  );
  if (allowedSpans.length === 0) {
    return {
      result: labels.empty,
      resultCount: 0,
      fileCount: 0
    };
  }

  const displaySpans = takeFormattedItems(allowedSpans);
  const totalGroups = groupByFile(allowedSpans, (span) => span.fileName).size;
  const grouped = groupByFile(displaySpans, (span) => span.fileName);
  const countLabel = allowedSpans.length === 1 ? labels.singular : labels.plural;
  const lines = [
    `Found ${allowedSpans.length} ${countLabel} across ${totalGroups} ${plural(totalGroups, "file")}:`
  ];
  for (const [fileName, entries] of grouped) {
    lines.push("", `${formatPath(project.workspaceRoot, fileName)}:`);
    for (const entry of entries) {
      const location = getLineAndCharacter(project, entry.fileName, entry.textSpan.start);
      const identity = [entry.name, entry.kind ? `(${formatKind(entry.kind)})` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`  Line ${location.line}:${location.character}${identity ? ` - ${identity}` : ""}`);
    }
  }
  appendLimitNotice(lines, allowedSpans.length, displaySpans.length, countLabel);

  return {
    result: truncate(lines.join("\n")),
    resultCount: allowedSpans.length,
    fileCount: totalGroups
  };
}

function formatNavigationNode(
  project: TypeScriptProject,
  node: ts.NavigationTree,
  depth: number,
  budget: FormatBudget
): string[] {
  if (budget.formattedCount >= budget.maxItems) {
    budget.truncated = true;
    return [];
  }

  const span = node.nameSpan ?? node.spans[0];
  const location = span ? getLineAndCharacter(project, project.fileName, span.start) : undefined;
  const detail = location ? ` - Line ${location.line}` : "";
  const lines = [`${"  ".repeat(depth)}${node.text} (${formatKind(node.kind)})${detail}`];
  budget.formattedCount += 1;

  for (const child of node.childItems ?? []) {
    lines.push(...formatNavigationNode(project, child, depth + 1, budget));
    if (budget.truncated) {
      break;
    }
  }

  return lines;
}

function countNavigationNodes(nodes: readonly ts.NavigationTree[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countNavigationNodes(node.childItems ?? []);
  }

  return count;
}

function formatCallItem(project: TypeScriptProject, item: ts.CallHierarchyItem) {
  const location = getLineAndCharacter(project, item.file, item.selectionSpan.start);
  const container = item.containerName ? ` in ${item.containerName}` : "";
  return `${item.name} (${formatKind(item.kind)}) - ${formatPath(project.workspaceRoot, item.file)}:${location.line}:${location.character}${container}`;
}

function getPosition(sourceFile: ts.SourceFile, line: number, character: number) {
  const lineStarts = sourceFile.getLineStarts();
  const lineIndex = line - 1;
  if (lineIndex < 0 || lineIndex >= lineStarts.length) {
    throw new Error(`Line ${line} is outside the file range (1-${lineStarts.length}).`);
  }

  const lineStart = lineStarts[lineIndex]!;
  const nextLineStart = lineStarts[lineIndex + 1] ?? sourceFile.text.length + 1;
  const maxCharacter = Math.max(1, nextLineStart - lineStart);
  if (character < 1 || character > maxCharacter) {
    throw new Error(`Character ${character} is outside line ${line} range (1-${maxCharacter}).`);
  }

  return lineStart + character - 1;
}

function getLineAndCharacter(project: TypeScriptProject, fileName: string, position: number) {
  if (!isAllowedExistingPath(project.allowedRoots, fileName)) {
    throw new Error(`LSP result path is outside the allowed roots: ${fileName}`);
  }

  const sourceFile =
    project.service.getProgram()?.getSourceFile(fileName) ??
    createSourceFileFromDisk(project, fileName);
  const normalizedPosition = Math.max(0, Math.min(position, sourceFile.text.length));
  const location = sourceFile.getLineAndCharacterOfPosition(normalizedPosition);
  return {
    line: location.line + 1,
    character: location.character + 1
  };
}

function createSourceFileFromDisk(project: TypeScriptProject, fileName: string) {
  const content = project.sys.readFile(fileName) ?? "";
  return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
}

function assertSupportedFile(fileName: string) {
  if (!SUPPORTED_EXTENSIONS.has(path.extname(fileName))) {
    throw new Error(`LSP currently supports TypeScript/JavaScript files only: ${fileName}`);
  }
}

function assertRegularFile(fileName: string, allowedRoots: readonly string[]) {
  if (!isAllowedExistingPath(allowedRoots, fileName)) {
    throw new Error(`LSP only supports files inside allowed roots: ${fileName}`);
  }

  const stats = statSync(fileName);
  if (!stats.isFile()) {
    throw new Error(`LSP only supports files: ${fileName}`);
  }
}

function getFileVersion(fileName: string, allowedRoots: readonly string[]) {
  try {
    if (!isAllowedExistingPath(allowedRoots, fileName)) {
      return "0";
    }

    return String(statSync(fileName).mtimeMs);
  } catch {
    return "0";
  }
}

function formatDiagnostic(diagnostic: ts.Diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function normalizeFileName(fileName: string) {
  const resolved = path.resolve(fileName);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function formatPath(workspaceRoot: string, fileName: string) {
  const relativePath = path.relative(workspaceRoot, fileName);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.replace(/\\/g, "/");
  }

  return fileName.replace(/\\/g, "/");
}

function formatKind(kind: string) {
  return kind.replace(/_/g, " ");
}

function plural(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}

function groupByFile<T>(items: readonly T[], getFileName?: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const fileName = getFileName ? getFileName(item) : (item as { fileName: string }).fileName;
    const existing = groups.get(fileName);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(fileName, [item]);
    }
  }

  return groups;
}

function countUnique(values: string[]) {
  return new Set(values).size;
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

type FormatBudget = {
  maxItems: number;
  formattedCount: number;
  truncated: boolean;
};

function createFormatBudget(): FormatBudget {
  return {
    maxItems: MAX_FORMATTED_ITEMS,
    formattedCount: 0,
    truncated: false
  };
}

function takeFormattedItems<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_FORMATTED_ITEMS);
}

function appendLimitNotice(
  lines: string[],
  totalCount: number,
  displayedCount: number,
  label: string
) {
  if (displayedCount >= totalCount) {
    return;
  }

  lines.push(
    "",
    `Showing first ${displayedCount} ${label}; ${totalCount - displayedCount} omitted.`
  );
}

function formatCallSites(
  project: TypeScriptProject,
  fileName: string,
  spans: readonly ts.TextSpan[]
) {
  const displaySpans = spans.slice(0, MAX_CALL_SITE_LOCATIONS);
  const sites = displaySpans.map((span) => {
    const site = getLineAndCharacter(project, fileName, span.start);
    return `${site.line}:${site.character}`;
  });

  if (displaySpans.length < spans.length) {
    sites.push(`+${spans.length - displaySpans.length} more`);
  }

  return sites;
}

function createRestrictedTypeScriptSystem(allowedRoots: readonly string[]): RestrictedTypeScriptSystem {
  const isAllowed = (candidatePath: string) => isAllowedExistingPath(allowedRoots, candidatePath);
  const isAllowedDirectory = (candidatePath: string) =>
    isAllowed(candidatePath) && (ts.sys.directoryExists?.(candidatePath) ?? existsSync(candidatePath));

  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (fileName) => isAllowed(fileName) && ts.sys.fileExists(fileName),
    readFile: (fileName, encoding) =>
      isAllowed(fileName) ? ts.sys.readFile(fileName, encoding) : undefined,
    readDirectory: (rootDir, extensions, excludes, includes, depth) => {
      if (!isAllowedDirectory(rootDir)) {
        return [];
      }

      return ts.sys
        .readDirectory(rootDir, extensions, excludes, includes, depth)
        .filter((fileName) => isAllowed(fileName));
    },
    directoryExists: (directoryName) => isAllowedDirectory(directoryName),
    getDirectories: (directoryName) => {
      if (!isAllowedDirectory(directoryName)) {
        return [];
      }

      return ts.sys.getDirectories(directoryName).filter((childDirectory) =>
        isAllowedDirectory(childDirectory)
      );
    },
    realpath: (fileName) => {
      const realPath = getRealPath(fileName);
      return realPath && isPathAllowed(allowedRoots, realPath) ? realPath : path.resolve(fileName);
    }
  };
}

function isAllowedExistingPath(allowedRoots: readonly string[], fileName: string) {
  const normalized = path.resolve(fileName);
  if (!isPathAllowed(allowedRoots, normalized)) {
    return false;
  }

  if (!existsSync(normalized)) {
    return true;
  }

  const realPath = getRealPath(normalized);
  return realPath ? isPathAllowed(allowedRoots, realPath) : false;
}

function getRealPath(fileName: string) {
  try {
    return realpathSync(fileName);
  } catch {
    return undefined;
  }
}
