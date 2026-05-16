import path from "node:path";
import type { PermissionCategory } from "../../core/permissions/permissionRules.js";
import type { ToolExecutionContext, ToolPermissionKind } from "../types.js";
import { toWorkspaceRelative } from "./pathSandbox.js";

export interface FilePermissionMetadata {
  absolutePath: string;
  displayPath: string;
  permissionPattern: string;
  isInsideWorkspace: boolean;
  sensitiveReasons: string[];
  generatedReasons: string[];
  forceAsk: boolean;
}

export interface FilePermissionApprovalOptions {
  toolName: string;
  title?: string;
  permission: PermissionCategory;
  kind?: ToolPermissionKind;
  actionLabel: string;
  details?: string[];
  forceAsk?: boolean;
}

const PRIVATE_KEY_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_xmss",
  "identity",
  "credentials",
  "authorized_keys"
]);

const PRIVATE_KEY_EXTENSIONS = new Set([
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".jks"
]);

const SECRET_CONFIG_BASENAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "secrets.json",
  "secret.json",
  "tokens.json"
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "node_modules"
]);

export const SENSITIVE_RIPGREP_EXCLUDE_GLOBS = [
  "!.env",
  "!.env.*",
  "!**/.env",
  "!**/.env.*",
  "!**/.alyce/**",
  "!**/.npmrc",
  "!**/.pypirc",
  "!**/.netrc",
  "!**/id_rsa",
  "!**/id_dsa",
  "!**/id_ecdsa",
  "!**/id_ed25519",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p12",
  "!**/*.pfx"
] as const;

export function getFilePermissionMetadata(
  workspaceRoot: string,
  absolutePath: string
): FilePermissionMetadata {
  const resolvedPath = path.resolve(absolutePath);
  const displayPath = toWorkspaceRelative(workspaceRoot, resolvedPath);
  const isInsideWorkspace = displayPath !== resolvedPath;
  const sensitiveReasons = getSensitivePathReasons(workspaceRoot, resolvedPath);
  const generatedReasons = getGeneratedPathReasons(workspaceRoot, resolvedPath);
  return {
    absolutePath: resolvedPath,
    displayPath,
    permissionPattern: sensitiveReasons.length > 0
      ? `sensitive:${normalizePatternPath(displayPath)}`
      : isInsideWorkspace
        ? `workspace:${normalizePatternPath(displayPath)}`
        : `external:${normalizePatternPath(resolvedPath)}`,
    isInsideWorkspace,
    sensitiveReasons,
    generatedReasons,
    forceAsk: sensitiveReasons.length > 0 || generatedReasons.length > 0
  };
}

export async function requestFilePermission(
  context: ToolExecutionContext,
  absolutePath: string,
  options: FilePermissionApprovalOptions
): Promise<FilePermissionMetadata> {
  const metadata = getFilePermissionMetadata(context.workspaceRoot, absolutePath);
  const approved = await context.requestApproval({
    kind: options.kind ?? "file-write",
    toolName: options.toolName,
    title: options.title ?? options.actionLabel,
    summary: metadata.displayPath,
    details: [
      `Action: ${options.actionLabel}`,
      `Path: ${metadata.displayPath}`,
      ...formatFilePermissionDetails(metadata),
      ...(options.details ?? [])
    ],
    permission: {
      permission: options.permission,
      pattern: metadata.permissionPattern
    },
    forceAsk: options.forceAsk ?? metadata.forceAsk
  });

  if (!approved) {
    throw new Error(`User rejected ${options.actionLabel}: ${metadata.displayPath}`);
  }

  return metadata;
}

export async function requestSensitiveFileReadApproval(
  context: ToolExecutionContext,
  absolutePath: string,
  options: {
    toolName: string;
    actionLabel?: string;
    details?: string[];
  }
): Promise<FilePermissionMetadata> {
  const metadata = getFilePermissionMetadata(context.workspaceRoot, absolutePath);
  if (metadata.sensitiveReasons.length === 0) {
    return metadata;
  }

  const approved = await context.requestApproval({
    kind: "file-read",
    toolName: options.toolName,
    title: "Read sensitive path",
    summary: metadata.displayPath,
    details: [
      `Action: ${options.actionLabel ?? "read/search"}`,
      `Path: ${metadata.displayPath}`,
      ...formatFilePermissionDetails(metadata),
      ...(options.details ?? [])
    ],
    permission: {
      permission: "file.read",
      pattern: metadata.permissionPattern
    },
    forceAsk: true
  });

  if (!approved) {
    throw new Error(`User rejected sensitive file access: ${metadata.displayPath}`);
  }

  return metadata;
}

export function formatFilePermissionDetails(metadata: FilePermissionMetadata): string[] {
  const details = [
    `Permission pattern: ${metadata.permissionPattern}`
  ];

  for (const reason of metadata.sensitiveReasons) {
    details.push(`Sensitive path: ${reason}`);
  }

  for (const reason of metadata.generatedReasons) {
    details.push(`Generated output warning: ${reason}`);
  }

  if (metadata.forceAsk) {
    details.push("Explicit approval required: broad session allow rules will not skip this prompt.");
  }

  return details;
}

export function getPatchPermissionPattern(
  workspaceRoot: string,
  absolutePaths: readonly string[]
): string {
  const uniquePatterns = [...new Set(absolutePaths.map((absolutePath) =>
    getFilePermissionMetadata(workspaceRoot, absolutePath).permissionPattern
  ))];
  if (uniquePatterns.length === 1) {
    return uniquePatterns[0]!;
  }

  if (uniquePatterns.every((pattern) => pattern.startsWith("workspace:"))) {
    return "workspace:*";
  }

  return `patch:${uniquePatterns.sort().join(";")}`;
}

export function getAggregateFilePermissionDetails(
  workspaceRoot: string,
  absolutePaths: readonly string[]
): {
  details: string[];
  forceAsk: boolean;
} {
  const metadatas = absolutePaths.map((absolutePath) =>
    getFilePermissionMetadata(workspaceRoot, absolutePath)
  );
  const details: string[] = [];
  const seen = new Set<string>();

  for (const metadata of metadatas) {
    for (const detail of formatFilePermissionDetails(metadata)) {
      const key = `${metadata.displayPath}:${detail}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      details.push(`${metadata.displayPath}: ${detail}`);
    }
  }

  return {
    details,
    forceAsk: metadatas.some((metadata) => metadata.forceAsk)
  };
}

export function isSensitivePath(workspaceRoot: string, absolutePath: string): boolean {
  return getSensitivePathReasons(workspaceRoot, absolutePath).length > 0;
}

function getSensitivePathReasons(workspaceRoot: string, absolutePath: string): string[] {
  const segments = getPathSegments(absolutePath);
  const basename = path.basename(absolutePath);
  const lowerBasename = basename.toLowerCase();
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const reasons: string[] = [];

  if (lowerBasename === ".env" || lowerBasename.startsWith(".env.")) {
    reasons.push("environment files often contain API keys or secrets");
  }

  if (lowerSegments.includes(".alyce")) {
    reasons.push("Alyce internal state may contain local config, memory, or session data");
  }

  if (PRIVATE_KEY_BASENAMES.has(lowerBasename) || PRIVATE_KEY_EXTENSIONS.has(path.extname(lowerBasename))) {
    reasons.push("private key or certificate-like filename");
  }

  if (SECRET_CONFIG_BASENAMES.has(lowerBasename)) {
    reasons.push("credential-bearing config filename");
  }

  if (lowerSegments.includes(".aws") && (lowerBasename === "credentials" || lowerBasename === "config")) {
    reasons.push("AWS credential/config path");
  }

  if (lowerSegments.includes(".kube") && lowerBasename === "config") {
    reasons.push("Kubernetes config path can contain tokens or client certificates");
  }

  if (lowerSegments.includes(".docker") && lowerBasename === "config.json") {
    reasons.push("Docker config can contain registry credentials");
  }

  const displayPath = toWorkspaceRelative(workspaceRoot, absolutePath);
  if (displayPath !== absolutePath && displayPath.split(/[\\/]/).some((part) =>
    part.toLowerCase() === "secrets" ||
    part.toLowerCase() === "secret"
  )) {
    reasons.push("path is inside a secrets directory");
  }

  return [...new Set(reasons)];
}

function getGeneratedPathReasons(workspaceRoot: string, absolutePath: string): string[] {
  const displayPath = toWorkspaceRelative(workspaceRoot, absolutePath);
  if (displayPath === absolutePath) {
    return [];
  }

  const segments = displayPath
    .split(/[\\/]/)
    .map((segment) => segment.toLowerCase());
  const generatedSegments = segments.filter((segment) => GENERATED_DIRECTORY_NAMES.has(segment));
  return [...new Set(generatedSegments)].map((segment) =>
    `${segment} is usually generated output; prefer changing source files unless the user explicitly requested this path`
  );
}

function getPathSegments(absolutePath: string): string[] {
  return path
    .resolve(absolutePath)
    .split(/[\\/]+/)
    .filter(Boolean);
}

function normalizePatternPath(value: string): string {
  return value.replace(/\\/g, "/");
}
