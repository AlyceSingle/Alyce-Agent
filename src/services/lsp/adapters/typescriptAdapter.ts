import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type tsNamespace from "typescript";
import { loadTypeScriptModule } from "./typescriptModule.js";
import { isPathAllowed, toWorkspaceRelative } from "../../../tools/internal/pathSandbox.js";
import { truncate } from "../../../tools/internal/values.js";
import type {
  LspRuntimeAdapter,
  LspRuntimeBackendHealth,
  LspRuntimeDiagnosticsResult,
  LspRuntimeOperation,
  LspRuntimeQueryPayload,
  ResolvedLspRuntimeFileInput,
  ResolvedLspRuntimeQueryInput
} from "../types.js";
import {
  TYPESCRIPT_LSP_BACKEND_CAPABILITIES,
  TYPESCRIPT_LSP_SUPPORTED_OPERATIONS,
  isTypeScriptLspSupportedFile
} from "./typescriptAdapterMetadata.js";

const SUPPORTED_OPERATION_SET = new Set<LspRuntimeOperation>(TYPESCRIPT_LSP_SUPPORTED_OPERATIONS);

const DEFAULT_MAX_WORKSPACE_SYMBOLS = 100;
const MAX_FORMATTED_ITEMS = 200;
const MAX_CALL_SITE_LOCATIONS = 20;
const MAX_DIAGNOSTICS = 20;
const MAX_PROJECT_DIAGNOSTIC_FILES = 5;
const MAX_PROJECT_SCAN_FILES = 50;
const MAX_PROJECT_ROOT_FILES_FOR_SCAN = 500;
const DEFAULT_MAX_CACHED_PROJECTS = 24;
const DEFAULT_CACHE_ENTRY_IDLE_TTL_MS = 15 * 60_000;

type TypeScriptProject = {
  service: tsNamespace.LanguageService;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  fileName: string;
  rootFileNames: string[];
  sourceVersions: Map<string, string>;
  sourceFile: tsNamespace.SourceFile;
  sys: RestrictedTypeScriptSystem;
};

type CachedTypeScriptProject = {
  service: tsNamespace.LanguageService;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  rootFileNames: string[];
  sourceVersions: Map<string, string>;
  sys: RestrictedTypeScriptSystem;
  lastAccessAtMs: number;
};

type TypeScriptProjectCachePolicy = {
  maxProjects: number;
  idleTtlMs: number;
};

type TypeScriptLspCacheStats = {
  cacheHits: number;
  cacheMisses: number;
  capacityEvictions: number;
  staleEvictions: number;
  closeEvictions: number;
  disposedProjects: number;
  lastEvictionAtMs: number;
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
  textSpan: tsNamespace.TextSpan;
  kind?: string;
  name?: string;
  containerName?: string;
  isDefinition?: boolean;
};

type TypeScriptDiagnosticSeverity = "error" | "warning" | "suggestion" | "message";

type TypeScriptDiagnosticIssue = {
  filePath: string;
  line: number;
  character: number;
  severity: TypeScriptDiagnosticSeverity;
  code: string;
  message: string;
  source?: string;
};

const loadedTypeScript = loadTypeScriptModule();
// Every public adapter entry guards through requireTypeScriptModule(), so the
// non-null assertion never leaks: internal helpers only run behind the guard.
const ts = (loadedTypeScript?.module ?? null) as unknown as typeof tsNamespace;

const projectCache = new Map<string, CachedTypeScriptProject>();
const syncedVersionOffsets = new Map<string, number>();
let projectCachePolicy: TypeScriptProjectCachePolicy = {
  maxProjects: DEFAULT_MAX_CACHED_PROJECTS,
  idleTtlMs: DEFAULT_CACHE_ENTRY_IDLE_TTL_MS
};
const typeScriptLspCacheStats = createEmptyTypeScriptLspCacheStats();

export const typescriptLspAdapter: LspRuntimeAdapter = {
  backend: "typescript-language-service",
  capabilities: TYPESCRIPT_LSP_BACKEND_CAPABILITIES,
  isSupportedFile: isTypeScriptLspSupportedFile,
  supportsOperation,
  execute,
  getHealth,
  getDiagnostics,
  syncFileChange,
  syncFileSave,
  syncFileClose
};

export const __TYPESCRIPT_LSP_ADAPTER_TESTING__ = {
  resetStateForTesting,
  setCachePolicyForTesting,
  getCacheSnapshotForTesting
};

function supportsOperation(operation: LspRuntimeOperation) {
  return SUPPORTED_OPERATION_SET.has(operation);
}

function requireTypeScriptModule() {
  if (!loadedTypeScript) {
    throw new Error(
      "TypeScript backend is unavailable: no usable typescript module (>=5.0) was found. " +
        "Install it in your project, for example: npm i -D typescript."
    );
  }
}

function getHealth(): LspRuntimeBackendHealth {
  if (!loadedTypeScript) {
    return {
      backend: "typescript-language-service",
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      message:
        "No usable typescript module (>=5.0) was found; TypeScript LSP features and diagnostics are disabled. Install typescript in your project to enable them."
    };
  }

  const snapshot = getCacheSnapshotForTesting();
  const atCapacity = snapshot.activeProjectCount >= snapshot.policy.maxProjects;
  const now = Date.now();
  const recentEvictionWindowMs = Math.max(250, Math.min(snapshot.policy.idleTtlMs, 300_000));
  const hadRecentPressure =
    snapshot.stats.lastEvictionAtMs > 0 &&
    now - snapshot.stats.lastEvictionAtMs <= recentEvictionWindowMs;

  return {
    backend: "typescript-language-service",
    status: atCapacity || hadRecentPressure ? "degraded" : "ready",
    checkedAt: new Date().toISOString(),
    message: [
      `Active TypeScript language service projects: ${snapshot.activeProjectCount}.`,
      `Cache policy: max=${snapshot.policy.maxProjects}, idleTtlMs=${snapshot.policy.idleTtlMs}.`,
      `Cache stats: hits=${snapshot.stats.cacheHits}, misses=${snapshot.stats.cacheMisses}, staleEvictions=${snapshot.stats.staleEvictions}, capacityEvictions=${snapshot.stats.capacityEvictions}.`,
      snapshot.stats.lastEvictionAtMs > 0
        ? `Last eviction: ${new Date(snapshot.stats.lastEvictionAtMs).toISOString()}.`
        : "Last eviction: never."
    ].join(" ")
  };
}

function execute(input: ResolvedLspRuntimeQueryInput): LspRuntimeQueryPayload {
  requireTypeScriptModule();
  assertRegularFile(input.absolutePath, input.allowedRoots);

  const project = createTypeScriptProject({
    fileName: input.absolutePath,
    workspaceRoot: input.workspaceRoot,
    allowedRoots: input.allowedRoots
  });

  switch (input.operation) {
    case "goToDefinition":
      return runGoToDefinition(project, getRequiredPosition(project, input));
    case "findReferences":
      return runFindReferences(project, getRequiredPosition(project, input));
    case "hover":
      return runHover(project, getRequiredPosition(project, input));
    case "documentSymbol":
      return runDocumentSymbol(project);
    case "workspaceSymbol":
      return runWorkspaceSymbol(project, input.query, input.maxResults);
    case "goToImplementation":
      return runGoToImplementation(project, getRequiredPosition(project, input));
    case "prepareCallHierarchy":
      return runPrepareCallHierarchy(project, getRequiredPosition(project, input));
    case "incomingCalls":
      return runIncomingCalls(project, getRequiredPosition(project, input));
    case "outgoingCalls":
      return runOutgoingCalls(project, getRequiredPosition(project, input));
  }
}

function getDiagnostics(input: ResolvedLspRuntimeFileInput): LspRuntimeDiagnosticsResult {
  requireTypeScriptModule();
  assertRegularFile(input.absolutePath, input.allowedRoots);
  const project = createTypeScriptProject({
    fileName: input.absolutePath,
    workspaceRoot: input.workspaceRoot,
    allowedRoots: input.allowedRoots
  });

  const rootFileNames =
    project.rootFileNames.length > MAX_PROJECT_ROOT_FILES_FOR_SCAN
      ? [project.fileName]
      : project.rootFileNames;
  const diagnostics = collectDiagnostics({
    service: project.service,
    targetFileName: project.fileName,
    rootFileNames,
    allowedRoots: project.allowedRoots
  });
  const issues = diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) =>
    formatDiagnosticIssue(diagnostic, project.workspaceRoot, project.fileName)
  );

  return {
    backend: "typescript-language-service",
    issues,
    totalIssueCount: diagnostics.length,
    truncated: diagnostics.length > issues.length
  };
}

function syncFileChange(input: ResolvedLspRuntimeFileInput) {
  if (!loadedTypeScript) {
    return;
  }
  bumpSyncedVersion(input.absolutePath);
}

function syncFileSave(input: ResolvedLspRuntimeFileInput) {
  if (!loadedTypeScript) {
    return;
  }
  bumpSyncedVersion(input.absolutePath);
  if (!isTypeScriptLspSupportedFile(input.absolutePath)) {
    return;
  }

  for (const project of projectCache.values()) {
    if (!isWorkspaceRootEquivalent(project.workspaceRoot, input.workspaceRoot)) {
      continue;
    }
    if (!areAllowedRootsEquivalent(project.allowedRoots, input.allowedRoots)) {
      continue;
    }
    ensureProjectIncludesRootFile(project, input.absolutePath);
  }
}

function syncFileClose(input: ResolvedLspRuntimeFileInput) {
  if (!loadedTypeScript) {
    return;
  }
  const normalized = normalizeFileName(input.absolutePath);
  syncedVersionOffsets.delete(normalized);

  for (const [cacheKey, project] of projectCache.entries()) {
    const index = project.rootFileNames.findIndex((fileName) => normalizeFileName(fileName) === normalized);
    if (index < 0) {
      continue;
    }

    project.rootFileNames.splice(index, 1);
    project.sourceVersions.delete(normalized);
    if (project.rootFileNames.length === 0) {
      disposeCachedProject(cacheKey, "close");
    }
  }
}

function createProjectCacheKey(options: {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
}) {
  const normalizedWorkspace = normalizeFileName(options.workspaceRoot);
  const normalizedFileName = normalizeFileName(options.fileName);
  const normalizedAllowedRoots = [...new Set(options.allowedRoots.map(normalizeFileName))]
    .sort((left, right) => left.localeCompare(right))
    .join("|");
  return `${normalizedWorkspace}::${normalizedAllowedRoots}::${normalizedFileName}`;
}

function createCachedTypeScriptProject(options: {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
}): CachedTypeScriptProject {
  const now = Date.now();
  const sys = createRestrictedTypeScriptSystem(options.allowedRoots);
  const config = loadCompilerConfig(options.fileName, options.allowedRoots, sys);
  const rootFileNames = ensureRootFile(config.fileNames, options.fileName, options.allowedRoots);
  const sourceVersions = new Map<string, string>();

  for (const fileName of rootFileNames) {
    sourceVersions.set(normalizeFileName(fileName), getFileVersion(fileName, options.allowedRoots));
  }

  const host: tsNamespace.LanguageServiceHost = {
    getCompilationSettings: () => config.options,
    getCurrentDirectory: () => config.currentDirectory,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getScriptFileNames: () => rootFileNames,
    getScriptSnapshot: (fileName) => {
      const content = sys.readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getScriptVersion: (fileName) => {
      const normalized = normalizeFileName(fileName);
      const next = getFileVersion(fileName, options.allowedRoots);
      const current = sourceVersions.get(normalized);
      if (current !== next) {
        sourceVersions.set(normalized, next);
      }

      return sourceVersions.get(normalized) ?? next;
    },
    fileExists: sys.fileExists,
    readDirectory: sys.readDirectory,
    readFile: sys.readFile,
    directoryExists: sys.directoryExists,
    getDirectories: sys.getDirectories,
    realpath: sys.realpath,
    useCaseSensitiveFileNames: () => sys.useCaseSensitiveFileNames
  };

  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    workspaceRoot: options.workspaceRoot,
    allowedRoots: [...options.allowedRoots],
    rootFileNames,
    sourceVersions,
    sys,
    lastAccessAtMs: now
  };
}

function ensureProjectIncludesRootFile(project: CachedTypeScriptProject, fileName: string) {
  if (!isTypeScriptLspSupportedFile(fileName) || !isAllowedExistingPath(project.allowedRoots, fileName)) {
    return;
  }

  const normalized = normalizeFileName(fileName);
  if (project.rootFileNames.some((existing) => normalizeFileName(existing) === normalized)) {
    return;
  }

  project.rootFileNames.push(fileName);
  project.sourceVersions.set(normalized, getFileVersion(fileName, project.allowedRoots));
}

function areAllowedRootsEquivalent(left: readonly string[], right: readonly string[]) {
  const leftSet = [...new Set(left.map(normalizeFileName))].sort((a, b) => a.localeCompare(b));
  const rightSet = [...new Set(right.map(normalizeFileName))].sort((a, b) => a.localeCompare(b));
  if (leftSet.length !== rightSet.length) {
    return false;
  }

  return leftSet.every((value, index) => value === rightSet[index]);
}

function bumpSyncedVersion(fileName: string) {
  const normalized = normalizeFileName(fileName);
  const next = (syncedVersionOffsets.get(normalized) ?? 0) + 1;
  syncedVersionOffsets.set(normalized, next);
}

function getRequiredPosition(project: TypeScriptProject, input: ResolvedLspRuntimeQueryInput) {
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
  const now = Date.now();
  maintainProjectCache(now);
  const cacheKey = createProjectCacheKey(options);
  const existing = projectCache.get(cacheKey);
  const cached = existing ?? createCachedTypeScriptProject(options);
  if (existing) {
    typeScriptLspCacheStats.cacheHits += 1;
  } else {
    typeScriptLspCacheStats.cacheMisses += 1;
  }
  touchCachedProject(cached, now);
  projectCache.set(cacheKey, cached);
  if (!existing) {
    maintainProjectCache(now);
  }
  ensureProjectIncludesRootFile(cached, options.fileName);
  const program = cached.service.getProgram();
  const sourceFile = program?.getSourceFile(options.fileName);
  if (!sourceFile) {
    throw new Error(`Unable to load file in TypeScript language service: ${options.fileName}`);
  }

  return {
    service: cached.service,
    workspaceRoot: cached.workspaceRoot,
    allowedRoots: cached.allowedRoots,
    fileName: options.fileName,
    rootFileNames: cached.rootFileNames,
    sourceVersions: cached.sourceVersions,
    sourceFile,
    sys: cached.sys
  };
}

function maintainProjectCache(now = Date.now()) {
  for (const [cacheKey, cached] of projectCache.entries()) {
    if (now - cached.lastAccessAtMs > projectCachePolicy.idleTtlMs) {
      disposeCachedProject(cacheKey, "stale");
    }
  }

  if (projectCache.size <= projectCachePolicy.maxProjects) {
    return;
  }

  const oldestFirst = [...projectCache.entries()]
    .sort((left, right) => left[1].lastAccessAtMs - right[1].lastAccessAtMs);
  const overflowCount = Math.max(0, projectCache.size - projectCachePolicy.maxProjects);

  for (let index = 0; index < overflowCount; index += 1) {
    const entry = oldestFirst[index];
    if (!entry) {
      break;
    }
    disposeCachedProject(entry[0], "capacity");
  }
}

function disposeCachedProject(cacheKey: string, reason: "close" | "stale" | "capacity" | "reset") {
  const cached = projectCache.get(cacheKey);
  if (!cached) {
    return;
  }

  cached.service.dispose();
  projectCache.delete(cacheKey);
  typeScriptLspCacheStats.disposedProjects += 1;
  if (reason === "close") {
    typeScriptLspCacheStats.closeEvictions += 1;
  } else if (reason === "stale") {
    typeScriptLspCacheStats.staleEvictions += 1;
    typeScriptLspCacheStats.lastEvictionAtMs = Date.now();
  } else if (reason === "capacity") {
    typeScriptLspCacheStats.capacityEvictions += 1;
    typeScriptLspCacheStats.lastEvictionAtMs = Date.now();
  }
}

function touchCachedProject(cached: CachedTypeScriptProject, atMs = Date.now()) {
  cached.lastAccessAtMs = atMs;
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
      throw new Error(formatCompilerDiagnostic(read.error));
    }

    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      sys,
      path.dirname(configPath),
      undefined,
      configPath
    );
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map(formatCompilerDiagnostic).join("\n"));
    }

    return {
      currentDirectory: path.dirname(configPath),
      fileNames: parsed.fileNames,
      options: ensureCompilerOptionsForTarget(parsed.options, fileName)
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
    } satisfies tsNamespace.CompilerOptions
  };
}

function ensureCompilerOptionsForTarget(
  options: tsNamespace.CompilerOptions,
  fileName: string
): tsNamespace.CompilerOptions {
  if (!isJavaScriptLikeFile(fileName) || options.allowJs) {
    return options;
  }

  return {
    ...options,
    allowJs: true
  };
}

function isJavaScriptLikeFile(fileName: string) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return true;
    default:
      return false;
  }
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
  node: tsNamespace.NavigationTree,
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

function countNavigationNodes(nodes: readonly tsNamespace.NavigationTree[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countNavigationNodes(node.childItems ?? []);
  }

  return count;
}

function formatCallItem(project: TypeScriptProject, item: tsNamespace.CallHierarchyItem) {
  const location = getLineAndCharacter(project, item.file, item.selectionSpan.start);
  const container = item.containerName ? ` in ${item.containerName}` : "";
  return `${item.name} (${formatKind(item.kind)}) - ${formatPath(project.workspaceRoot, item.file)}:${location.line}:${location.character}${container}`;
}

function getPosition(sourceFile: tsNamespace.SourceFile, line: number, character: number) {
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

function collectDiagnostics(options: {
  service: tsNamespace.LanguageService;
  targetFileName: string;
  rootFileNames: string[];
  allowedRoots: readonly string[];
}) {
  const targetDiagnostics = getDiagnosticsForFile(
    options.service,
    options.targetFileName,
    true
  );
  const projectDiagnostics: tsNamespace.Diagnostic[] = [];
  const target = normalizeFileName(options.targetFileName);
  let filesWithDiagnostics = 0;
  let scannedFiles = 0;

  for (const fileName of options.rootFileNames) {
    if (normalizeFileName(fileName) === target) {
      continue;
    }

    scannedFiles += 1;
    if (
      scannedFiles > MAX_PROJECT_SCAN_FILES ||
      filesWithDiagnostics >= MAX_PROJECT_DIAGNOSTIC_FILES
    ) {
      break;
    }

    const fileDiagnostics = getDiagnosticsForFile(options.service, fileName, false)
      .filter((diagnostic) => isDiagnosticInAllowedRoots(diagnostic, options.allowedRoots));
    if (fileDiagnostics.length === 0) {
      continue;
    }

    filesWithDiagnostics += 1;
    projectDiagnostics.push(...fileDiagnostics);
  }

  return [...targetDiagnostics, ...projectDiagnostics]
    .filter((diagnostic) => isDiagnosticInAllowedRoots(diagnostic, options.allowedRoots));
}

function getDiagnosticsForFile(
  service: tsNamespace.LanguageService,
  fileName: string,
  includeSuggestions: boolean
) {
  const diagnostics = [
    ...service.getSyntacticDiagnostics(fileName),
    ...service.getSemanticDiagnostics(fileName)
  ];

  if (includeSuggestions) {
    diagnostics.push(...service.getSuggestionDiagnostics(fileName));
  }

  return diagnostics;
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
  const normalized = normalizeFileName(fileName);
  const syncOffset = syncedVersionOffsets.get(normalized) ?? 0;

  try {
    if (!isAllowedExistingPath(allowedRoots, fileName)) {
      return `0:${syncOffset}`;
    }

    return `${statSync(fileName).mtimeMs}:${syncOffset}`;
  } catch {
    return `0:${syncOffset}`;
  }
}

function formatCompilerDiagnostic(diagnostic: tsNamespace.Diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function isDiagnosticInAllowedRoots(
  diagnostic: tsNamespace.Diagnostic,
  allowedRoots: readonly string[]
) {
  return !diagnostic.file || isAllowedExistingPath(allowedRoots, diagnostic.file.fileName);
}

function formatDiagnosticIssue(
  diagnostic: tsNamespace.Diagnostic,
  workspaceRoot: string,
  fallbackFileName: string
): TypeScriptDiagnosticIssue {
  const file = diagnostic.file;
  const position =
    file && diagnostic.start !== undefined
      ? file.getLineAndCharacterOfPosition(Math.max(0, diagnostic.start))
      : { line: 0, character: 0 };

  return {
    filePath: toWorkspaceRelative(workspaceRoot, file?.fileName ?? fallbackFileName),
    line: position.line + 1,
    character: position.character + 1,
    severity: formatDiagnosticSeverity(diagnostic.category),
    code: String(diagnostic.code),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ...(diagnostic.source ? { source: diagnostic.source } : {})
  };
}

function formatDiagnosticSeverity(category: tsNamespace.DiagnosticCategory): TypeScriptDiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
    default:
      return "message";
  }
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
  spans: readonly tsNamespace.TextSpan[]
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

function resetStateForTesting() {
  for (const cacheKey of [...projectCache.keys()]) {
    disposeCachedProject(cacheKey, "reset");
  }
  syncedVersionOffsets.clear();
  projectCachePolicy = {
    maxProjects: DEFAULT_MAX_CACHED_PROJECTS,
    idleTtlMs: DEFAULT_CACHE_ENTRY_IDLE_TTL_MS
  };
  const empty = createEmptyTypeScriptLspCacheStats();
  typeScriptLspCacheStats.cacheHits = empty.cacheHits;
  typeScriptLspCacheStats.cacheMisses = empty.cacheMisses;
  typeScriptLspCacheStats.capacityEvictions = empty.capacityEvictions;
  typeScriptLspCacheStats.staleEvictions = empty.staleEvictions;
  typeScriptLspCacheStats.closeEvictions = empty.closeEvictions;
  typeScriptLspCacheStats.disposedProjects = empty.disposedProjects;
  typeScriptLspCacheStats.lastEvictionAtMs = empty.lastEvictionAtMs;
}

function setCachePolicyForTesting(policy: Partial<TypeScriptProjectCachePolicy>) {
  projectCachePolicy = {
    maxProjects: clampPositiveInt(policy.maxProjects, projectCachePolicy.maxProjects),
    idleTtlMs: clampPositiveInt(policy.idleTtlMs, projectCachePolicy.idleTtlMs)
  };
  maintainProjectCache();
}

function getCacheSnapshotForTesting() {
  const projects = [...projectCache.entries()].map(([cacheKey, project]) => ({
    cacheKey,
    workspaceRoot: project.workspaceRoot,
    rootFileNames: [...project.rootFileNames]
  }));
  return {
    activeProjectCount: projectCache.size,
    cacheKeys: [...projectCache.keys()],
    projects,
    policy: {
      maxProjects: projectCachePolicy.maxProjects,
      idleTtlMs: projectCachePolicy.idleTtlMs
    },
    stats: {
      cacheHits: typeScriptLspCacheStats.cacheHits,
      cacheMisses: typeScriptLspCacheStats.cacheMisses,
      capacityEvictions: typeScriptLspCacheStats.capacityEvictions,
      staleEvictions: typeScriptLspCacheStats.staleEvictions,
      closeEvictions: typeScriptLspCacheStats.closeEvictions,
      disposedProjects: typeScriptLspCacheStats.disposedProjects,
      lastEvictionAtMs: typeScriptLspCacheStats.lastEvictionAtMs
    }
  };
}

function createEmptyTypeScriptLspCacheStats(): TypeScriptLspCacheStats {
  return {
    cacheHits: 0,
    cacheMisses: 0,
    capacityEvictions: 0,
    staleEvictions: 0,
    closeEvictions: 0,
    disposedProjects: 0,
    lastEvictionAtMs: 0
  };
}

function isWorkspaceRootEquivalent(left: string, right: string) {
  return normalizeFileName(left) === normalizeFileName(right);
}

function clampPositiveInt(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value!));
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
