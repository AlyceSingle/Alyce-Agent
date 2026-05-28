import { throwIfAborted } from "../../core/abort.js";
import { resolvePathFromInput, toWorkspaceRelative } from "../../tools/internal/pathSandbox.js";
import type {
  LspRuntimeAdapter,
  LspRuntimeBackendCapabilities,
  LspRuntimeBackendHealth,
  LspRuntimeBackendSnapshot,
  LspRuntimeDiagnosticsResult,
  LspRuntimeFileInput,
  LspRuntimeOperation,
  LspRuntimeUnsupportedOperationErrorData,
  ResolvedLspRuntimeFileInput,
  LspRuntimeQueryInput,
  LspRuntimeQueryResult
} from "./types.js";
import {
  TYPESCRIPT_LSP_BACKEND_CAPABILITIES,
  isTypeScriptLspSupportedFile
} from "./adapters/typescriptAdapterMetadata.js";

const MAX_HEALTH_ERROR_MESSAGE_CHARS = 300;

export class LspRuntimeUnsupportedOperationError extends Error {
  readonly code = "lsp_unsupported_operation" as const;
  readonly backend: LspRuntimeUnsupportedOperationErrorData["backend"];
  readonly operation: LspRuntimeUnsupportedOperationErrorData["operation"];
  readonly filePath: string;
  readonly supportedOperations: LspRuntimeUnsupportedOperationErrorData["supportedOperations"];

  constructor(data: LspRuntimeUnsupportedOperationErrorData) {
    super(
      `LSP backend "${data.backend}" does not support operation "${data.operation}" for ${data.filePath}.`
    );
    this.name = "LspRuntimeUnsupportedOperationError";
    this.backend = data.backend;
    this.operation = data.operation;
    this.filePath = data.filePath;
    this.supportedOperations = [...data.supportedOperations];
  }

  toData(): LspRuntimeUnsupportedOperationErrorData {
    return {
      code: this.code,
      backend: this.backend,
      operation: this.operation,
      filePath: this.filePath,
      supportedOperations: [...this.supportedOperations]
    };
  }
}

export class LspRuntimeService {
  private readonly adapters: LspRuntimeAdapter[] = [];
  private readonly includeBuiltInTypeScriptAdapter: boolean;
  private typescriptAdapterPromise: Promise<LspRuntimeAdapter> | undefined;

  constructor(adapters?: readonly LspRuntimeAdapter[]) {
    this.adapters = [...(adapters ?? [])];
    this.includeBuiltInTypeScriptAdapter = adapters === undefined;
  }

  isSupportedFile(fileName: string): boolean {
    return this.adapters.some((adapter) => adapter.isSupportedFile(fileName)) ||
      (this.includeBuiltInTypeScriptAdapter && isTypeScriptLspSupportedFile(fileName));
  }

  getBackendSnapshot(): LspRuntimeBackendSnapshot[] {
    return this.getKnownAdaptersForSnapshot().map((adapter) => ({
      backend: adapter.backend,
      capabilities: cloneBackendCapabilities(adapter.capabilities),
      health: this.getAdapterHealth(adapter)
    }));
  }

  getBackendCapabilitiesSnapshot() {
    return this.getKnownAdaptersForSnapshot().map((adapter) => ({
      backend: adapter.backend,
      capabilities: cloneBackendCapabilities(adapter.capabilities)
    }));
  }

  getBackendHealthSnapshot() {
    return this.getKnownAdaptersForSnapshot().map((adapter) => this.getAdapterHealth(adapter));
  }

  async execute(input: LspRuntimeQueryInput): Promise<LspRuntimeQueryResult> {
    throwIfAborted(input.abortSignal);

    const absolutePath = resolvePathFromInput(
      input.workspaceRoot,
      input.allowedRoots,
      input.filePath
    );
    const runtimeFilePath = toWorkspaceRelative(input.workspaceRoot, absolutePath);
    const adapter = await this.resolveAdapter(absolutePath);
    this.assertOperationSupported(adapter, input.operation, runtimeFilePath);
    const result = adapter.execute({
      ...input,
      absolutePath
    });

    return {
      operation: input.operation,
      filePath: runtimeFilePath,
      backend: adapter.backend,
      backendCapabilities: cloneBackendCapabilities(adapter.capabilities),
      backendHealth: this.getAdapterHealth(adapter),
      ...result
    };
  }

  async getDiagnostics(input: LspRuntimeFileInput): Promise<LspRuntimeDiagnosticsResult> {
    throwIfAborted(input.abortSignal);
    const resolved = this.resolveFileInput(input);
    const adapter = await this.resolveAdapter(resolved.absolutePath);
    if (!adapter.getDiagnostics) {
      throw new Error(`LSP diagnostics are not implemented for backend: ${adapter.backend}`);
    }

    return adapter.getDiagnostics(resolved);
  }

  async syncFileChange(input: LspRuntimeFileInput): Promise<void> {
    throwIfAborted(input.abortSignal);
    const resolved = this.resolveFileInput(input);
    const adapter = await this.resolveAdapterOrNull(resolved.absolutePath);
    if (!adapter?.syncFileChange) {
      return;
    }

    adapter.syncFileChange(resolved);
  }

  async syncFileSave(input: LspRuntimeFileInput): Promise<void> {
    throwIfAborted(input.abortSignal);
    const resolved = this.resolveFileInput(input);
    const adapter = await this.resolveAdapterOrNull(resolved.absolutePath);
    if (!adapter?.syncFileSave) {
      return;
    }

    adapter.syncFileSave(resolved);
  }

  async syncFileClose(input: LspRuntimeFileInput): Promise<void> {
    throwIfAborted(input.abortSignal);
    const resolved = this.resolveFileInput(input);
    const adapter = await this.resolveAdapterOrNull(resolved.absolutePath);
    if (!adapter?.syncFileClose) {
      return;
    }

    adapter.syncFileClose(resolved);
  }

  private resolveFileInput(input: LspRuntimeFileInput): ResolvedLspRuntimeFileInput {
    const absolutePath = resolvePathFromInput(
      input.workspaceRoot,
      input.allowedRoots,
      input.filePath
    );
    return {
      ...input,
      absolutePath
    };
  }

  private async resolveAdapter(fileName: string): Promise<LspRuntimeAdapter> {
    const adapter = await this.resolveAdapterOrNull(fileName);
    if (!adapter) {
      throw new Error(`LSP currently supports TypeScript/JavaScript files only: ${fileName}`);
    }

    return adapter;
  }

  private async resolveAdapterOrNull(fileName: string): Promise<LspRuntimeAdapter | null> {
    const adapter = this.adapters.find((candidate) => candidate.isSupportedFile(fileName));
    if (adapter) {
      return adapter;
    }

    if (!this.includeBuiltInTypeScriptAdapter || !isTypeScriptLspSupportedFile(fileName)) {
      return null;
    }

    return this.loadTypeScriptAdapter();
  }

  private assertOperationSupported(
    adapter: LspRuntimeAdapter,
    operation: LspRuntimeOperation,
    filePath: string
  ) {
    const supported = adapter.supportsOperation
      ? adapter.supportsOperation(operation)
      : adapter.capabilities.supportedOperations.includes(operation);
    if (supported) {
      return;
    }

    throw new LspRuntimeUnsupportedOperationError({
      code: "lsp_unsupported_operation",
      backend: adapter.backend,
      operation,
      filePath,
      supportedOperations: [...adapter.capabilities.supportedOperations]
    });
  }

  private getAdapterHealth(adapter: LspRuntimeAdapter): LspRuntimeBackendHealth {
    const now = new Date().toISOString();
    try {
      const health = adapter.getHealth?.();
      if (!health) {
        return {
          backend: adapter.backend,
          status: "ready",
          checkedAt: now,
          message: "Backend is ready."
        };
      }

      return {
        ...health,
        backend: adapter.backend,
        checkedAt: health.checkedAt || now
      };
    } catch (error) {
      return {
        backend: adapter.backend,
        status: "degraded",
        checkedAt: now,
        message: `Backend health check failed: ${truncateHealthError(error)}`
      };
    }
  }

  private getKnownAdaptersForSnapshot(): LspRuntimeAdapter[] {
    if (this.adapters.length > 0) {
      return this.adapters;
    }

    if (this.includeBuiltInTypeScriptAdapter) {
      return [createTypeScriptAdapterSnapshot()];
    }

    return [];
  }

  private async loadTypeScriptAdapter(): Promise<LspRuntimeAdapter> {
    this.typescriptAdapterPromise ??= import("./adapters/typescriptAdapter.js")
      .then((module) => module.typescriptLspAdapter);
    const adapter = await this.typescriptAdapterPromise;
    if (!this.adapters.includes(adapter)) {
      this.adapters.push(adapter);
    }

    return adapter;
  }
}

export const lspRuntimeService = new LspRuntimeService();

export function isLspSupportedFile(fileName: string): boolean {
  return lspRuntimeService.isSupportedFile(fileName);
}

export function executeLspRuntimeQuery(input: LspRuntimeQueryInput): Promise<LspRuntimeQueryResult> {
  return lspRuntimeService.execute(input);
}

export function getLspRuntimeDiagnostics(input: LspRuntimeFileInput): Promise<LspRuntimeDiagnosticsResult> {
  return lspRuntimeService.getDiagnostics(input);
}

export function syncLspRuntimeFileChange(input: LspRuntimeFileInput): Promise<void> {
  return lspRuntimeService.syncFileChange(input);
}

export function syncLspRuntimeFileSave(input: LspRuntimeFileInput): Promise<void> {
  return lspRuntimeService.syncFileSave(input);
}

export function syncLspRuntimeFileClose(input: LspRuntimeFileInput): Promise<void> {
  return lspRuntimeService.syncFileClose(input);
}

export function getLspRuntimeBackendSnapshot(): LspRuntimeBackendSnapshot[] {
  return lspRuntimeService.getBackendSnapshot();
}

export function getLspRuntimeBackendCapabilitiesSnapshot() {
  return lspRuntimeService.getBackendCapabilitiesSnapshot();
}

export function getLspRuntimeBackendHealthSnapshot() {
  return lspRuntimeService.getBackendHealthSnapshot();
}

function cloneBackendCapabilities(capabilities: LspRuntimeBackendCapabilities): LspRuntimeBackendCapabilities {
  return {
    supportedOperations: [...capabilities.supportedOperations],
    supportsDiagnostics: capabilities.supportsDiagnostics,
    fileSync: {
      change: capabilities.fileSync.change,
      save: capabilities.fileSync.save,
      close: capabilities.fileSync.close
    },
    supportedFileExtensions: [...capabilities.supportedFileExtensions]
  };
}

function truncateHealthError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_HEALTH_ERROR_MESSAGE_CHARS);
}

function createTypeScriptAdapterSnapshot(): LspRuntimeAdapter {
  return {
    backend: "typescript-language-service",
    capabilities: TYPESCRIPT_LSP_BACKEND_CAPABILITIES,
    isSupportedFile: isTypeScriptLspSupportedFile,
    execute: () => {
      throw new Error("TypeScript language service has not been initialized.");
    },
    getHealth: () => ({
      backend: "typescript-language-service",
      status: "ready",
      checkedAt: new Date().toISOString(),
      message: "Backend is ready."
    })
  };
}
