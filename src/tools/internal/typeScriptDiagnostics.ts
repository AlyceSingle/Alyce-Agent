import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isPathAllowed, toWorkspaceRelative } from "./pathSandbox.js";

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

const MAX_DIAGNOSTICS = 20;
const MAX_PROJECT_DIAGNOSTIC_FILES = 5;
const MAX_PROJECT_SCAN_FILES = 50;
const MAX_PROJECT_ROOT_FILES_FOR_SCAN = 500;

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

export type TypeScriptDiagnosticSeverity = "error" | "warning" | "suggestion" | "message";

export interface TypeScriptDiagnosticIssue {
  filePath: string;
  line: number;
  character: number;
  severity: TypeScriptDiagnosticSeverity;
  code: string;
  message: string;
  source?: string;
}

export interface TypeScriptDiagnosticsResult {
  backend: "typescript-language-service";
  issues: TypeScriptDiagnosticIssue[];
  totalIssueCount: number;
  truncated: boolean;
}

export function isTypeScriptDiagnosticSupported(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export function getTypeScriptDiagnosticsForFile(options: {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
}): TypeScriptDiagnosticsResult {
  assertSupportedFile(options.fileName);
  assertRegularFile(options.fileName, options.allowedRoots);

  const sys = createRestrictedTypeScriptSystem(options.allowedRoots);
  const config = loadCompilerConfig(options.fileName, options.allowedRoots, sys);
  const configuredRootFileNames = ensureRootFile(
    config.fileNames,
    options.fileName,
    options.allowedRoots
  );
  const rootFileNames =
    configuredRootFileNames.length > MAX_PROJECT_ROOT_FILES_FOR_SCAN
      ? [options.fileName]
      : configuredRootFileNames;
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

  const diagnostics = collectDiagnostics({
    service,
    targetFileName: options.fileName,
    rootFileNames,
    allowedRoots: options.allowedRoots
  });

  const issues = diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) =>
    formatDiagnostic(diagnostic, options.workspaceRoot, options.fileName)
  );

  return {
    backend: "typescript-language-service",
    issues,
    totalIssueCount: diagnostics.length,
    truncated: diagnostics.length > issues.length
  };
}

function collectDiagnostics(options: {
  service: ts.LanguageService;
  targetFileName: string;
  rootFileNames: string[];
  allowedRoots: readonly string[];
}) {
  const targetDiagnostics = getDiagnosticsForFile(
    options.service,
    options.targetFileName,
    true
  );
  const projectDiagnostics: ts.Diagnostic[] = [];
  const target = normalizeFileName(options.targetFileName);
  let filesWithDiagnostics = 0;
  let scannedFiles = 0;

  for (const fileName of options.rootFileNames) {
    if (normalizeFileName(fileName) === target) {
      continue;
    }

    scannedFiles += 1;
    if (scannedFiles > MAX_PROJECT_SCAN_FILES || filesWithDiagnostics >= MAX_PROJECT_DIAGNOSTIC_FILES) {
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
  service: ts.LanguageService,
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

function assertSupportedFile(fileName: string) {
  if (!isTypeScriptDiagnosticSupported(fileName)) {
    throw new Error(`TypeScript diagnostics only support TypeScript/JavaScript files: ${fileName}`);
  }
}

function assertRegularFile(fileName: string, allowedRoots: readonly string[]) {
  if (!isAllowedExistingPath(allowedRoots, fileName)) {
    throw new Error(`Diagnostics only support files inside allowed roots: ${fileName}`);
  }

  const stats = statSync(fileName);
  if (!stats.isFile()) {
    throw new Error(`Diagnostics only support files: ${fileName}`);
  }
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
      throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
    }

    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      sys,
      path.dirname(configPath),
      undefined,
      configPath
    );
    if (parsed.errors.length > 0) {
      throw new Error(
        parsed.errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
          .join("\n")
      );
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

function normalizeFileName(fileName: string) {
  const resolved = path.resolve(fileName);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function isDiagnosticInAllowedRoots(
  diagnostic: ts.Diagnostic,
  allowedRoots: readonly string[]
) {
  return !diagnostic.file || isAllowedExistingPath(allowedRoots, diagnostic.file.fileName);
}

function formatDiagnostic(
  diagnostic: ts.Diagnostic,
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
    severity: formatSeverity(diagnostic.category),
    code: String(diagnostic.code),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ...(diagnostic.source ? { source: diagnostic.source } : {})
  };
}

function formatSeverity(category: ts.DiagnosticCategory): TypeScriptDiagnosticSeverity {
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
