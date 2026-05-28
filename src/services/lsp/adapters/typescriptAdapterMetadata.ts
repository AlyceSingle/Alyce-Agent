import path from "node:path";
import type {
  LspRuntimeBackendCapabilities,
  LspRuntimeOperation
} from "../types.js";

export const TYPESCRIPT_LSP_SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs"
] as const;

export const TYPESCRIPT_LSP_SUPPORTED_OPERATIONS: LspRuntimeOperation[] = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls"
];

export const TYPESCRIPT_LSP_BACKEND_CAPABILITIES: LspRuntimeBackendCapabilities = {
  supportedOperations: [...TYPESCRIPT_LSP_SUPPORTED_OPERATIONS],
  supportsDiagnostics: true,
  fileSync: {
    change: true,
    save: true,
    close: true
  },
  supportedFileExtensions: [...TYPESCRIPT_LSP_SUPPORTED_EXTENSIONS]
};

export function isTypeScriptLspSupportedFile(fileName: string): boolean {
  return TYPESCRIPT_LSP_SUPPORTED_EXTENSIONS.includes(
    path.extname(fileName).toLowerCase() as typeof TYPESCRIPT_LSP_SUPPORTED_EXTENSIONS[number]
  );
}
