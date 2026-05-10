import { throwIfAborted } from "../../core/abort.js";
import { resolvePathFromInput, toWorkspaceRelative } from "../../tools/internal/pathSandbox.js";
import { typescriptLspAdapter } from "./adapters/typescriptAdapter.js";
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
  constructor(private readonly adapters: readonly LspRuntimeAdapter[] = [typescriptLspAdapter]) {}

  isSupportedFile(fileName: string): boolean {
    return this.adapters.some((adapter) => adapter.isSupportedFile(fileName));
  }

  getBackendSnapshot(): LspRuntimeBackendSnapshot[] {
    return this.adapters.map((adapter) => ({
      backend: adapter.backend,
      capabilities: cloneBackendCapabilities(adapter.capabilities),
      health: this.getAdapterHealth(adapter)
    }));
  }

  getBackendCapabilitiesSnapshot() {
    return this.adapters.map((adapter) => ({
      backend: adapter.backend,
      capabilities: cloneBackendCapabilities(adapter.capabilities)
    }));
  }

  getBackendHealthSnapshot() {
    return this.adapters.map((adapter) => this.getAdapterHealth(adapter));
  }

  async execute(input: LspRuntimeQueryInput): Promise<LspRuntimeQueryResult> {
    throwIfAborted(input.abortSignal);

    const absolutePath = resolvePathFromInput(
      input.workspaceRoot,
      input.allowedRoots,
      input.filePath
    );
    const runtimeFilePath = toWorkspaceRelative(input.workspaceRoot, absolutePath);
    const adapter = this.resolveAdapter(absolutePath);
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
    const adapter = this.resolveAdapter(resolved.absolutePath);
    if (!adapter.getDiagnostics) {
      throw new Error(`LSP diagnostics are not implemented for backend: ${adapter.backend}`);
    }

    return adapter.getDiagnostics(resolved);
  }

  async syncFileChange(input: LspRuntimeFileInput): Promise<void> {
    throwIfAborted(input.abortSignal);
    const resolved = this.resolveFileInput(input);
    const adapter = this.resolveAdapterOrNull(resolved.absolutePath);
    if (!adapter?.syncFileChange) {
      return;
    }

    adapter.syncFileChange(resolved);
  }

  async syncFileSave(input: LspRuntimeFileInput): Promise<void> {
    throwIfAborted(input.abortSignal);
    const resolved = this.resolveFileInput(input);
    const adapter = this.resolveAdapterOrNull(resolved.absolutePath);
    if (!adapter?.syncFileSave) {
      return;
    }

    adapter.syncFileSave(resolved);
  }

  async syncFileClose(input: LspRuntimeFileInput): Promise<void> {
    throwIfAborted(input.abortSignal);
    const resolved = this.resolveFileInput(input);
    const adapter = this.resolveAdapterOrNull(resolved.absolutePath);
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

  private resolveAdapter(fileName: string): LspRuntimeAdapter {
    const adapter = this.resolveAdapterOrNull(fileName);
    if (!adapter) {
      throw new Error(`LSP currently supports TypeScript/JavaScript files only: ${fileName}`);
    }

    return adapter;
  }

  private resolveAdapterOrNull(fileName: string): LspRuntimeAdapter | null {
    return this.adapters.find((candidate) => candidate.isSupportedFile(fileName)) ?? null;
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
