import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  LspRuntimeDiagnosticIssue,
  LspRuntimeDiagnosticSeverity,
  LspRuntimeDiagnosticsResult
} from "../../services/lsp/types.js";
import { isTypeScriptLspSupportedFile } from "../../services/lsp/adapters/typescriptAdapterMetadata.js";
import { resolvePathFromInput } from "./pathSandbox.js";

const DEFAULT_DIAGNOSTICS_WORKER_TIMEOUT_MS = 60_000;

export type TypeScriptDiagnosticSeverity = LspRuntimeDiagnosticSeverity;
export type TypeScriptDiagnosticIssue = LspRuntimeDiagnosticIssue;

export interface TypeScriptDiagnosticsResult extends LspRuntimeDiagnosticsResult {
  backend: "typescript-language-service";
}

type WorkerRequest = {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: string[];
};

type WorkerSuccessResponse = {
  ok: true;
  result: TypeScriptDiagnosticsResult;
};

type WorkerFailureResponse = {
  ok: false;
  error: string;
};

export function isTypeScriptDiagnosticSupported(fileName: string): boolean {
  return isTypeScriptLspSupportedFile(fileName);
}

export async function getTypeScriptDiagnosticsForFile(options: {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
}): Promise<TypeScriptDiagnosticsResult> {
  if (!isTypeScriptDiagnosticSupported(options.fileName)) {
    throw new Error(`TypeScript diagnostics only support TypeScript/JavaScript files: ${options.fileName}`);
  }

  const { typescriptLspAdapter } = await import("../../services/lsp/adapters/typescriptAdapter.js");
  const absolutePath = resolvePathFromInput(
    options.workspaceRoot,
    options.allowedRoots,
    options.fileName
  );
  if (!typescriptLspAdapter.getDiagnostics) {
    throw new Error("TypeScript diagnostics backend is unavailable.");
  }

  return typescriptLspAdapter.getDiagnostics({
    filePath: options.fileName,
    absolutePath,
    workspaceRoot: options.workspaceRoot,
    allowedRoots: options.allowedRoots
  });
}

export function getTypeScriptDiagnosticsForFileAsync(options: {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: readonly string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<TypeScriptDiagnosticsResult> {
  const request: WorkerRequest = {
    fileName: options.fileName,
    workspaceRoot: options.workspaceRoot,
    allowedRoots: [...options.allowedRoots]
  };

  const worker = new Worker(new URL("./typeScriptDiagnosticsWorker.js", import.meta.url), {
    workerData: request
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      void worker.terminate();
      reject(new Error("Diagnostics aborted."));
    };

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.abortSignal?.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const settle = (handler: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      handler();
    };

    const onMessage = (message: unknown) => {
      if (isWorkerSuccessResponse(message)) {
        settle(() => resolve(message.result));
        return;
      }

      if (isWorkerFailureResponse(message)) {
        settle(() => reject(new Error(message.error)));
        return;
      }

      settle(() => reject(new Error("Diagnostics worker returned an invalid response.")));
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      settle(() => reject(
        new Error(
          code === 0
            ? "Diagnostics worker exited before returning a result."
            : `Diagnostics worker exited with code ${code}.`
        )
      ));
    };

    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_DIAGNOSTICS_WORKER_TIMEOUT_MS);
    timeout = setTimeout(() => {
      settle(() => {
        void worker.terminate();
        reject(new Error(`Diagnostics timed out after ${timeoutMs}ms.`));
      });
    }, timeoutMs);

    if (options.abortSignal?.aborted) {
      onAbort();
      return;
    }

    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function isWorkerSuccessResponse(message: unknown): message is WorkerSuccessResponse {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { ok?: unknown }).ok === true &&
      "result" in (message as Record<string, unknown>)
  );
}

function isWorkerFailureResponse(message: unknown): message is WorkerFailureResponse {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { ok?: unknown }).ok === false &&
      typeof (message as { error?: unknown }).error === "string"
  );
}
