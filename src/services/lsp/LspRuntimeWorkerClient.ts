import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  LspRuntimeQueryInput,
  LspRuntimeQueryResult
} from "./types.js";

const DEFAULT_LSP_WORKER_TIMEOUT_MS = 60_000;
const WORKER_FILE_NAMES = ["LspRuntimeWorker.cjs", "LspRuntimeWorker.js"] as const;

type WorkerRequest = Omit<LspRuntimeQueryInput, "abortSignal">;

type WorkerSuccessResponse = {
  ok: true;
  result: LspRuntimeQueryResult;
};

type WorkerFailureResponse = {
  ok: false;
  error: string;
};

export function executeLspRuntimeQueryAsync(
  options: LspRuntimeQueryInput & {
    timeoutMs?: number;
  }
): Promise<LspRuntimeQueryResult> {
  const request: WorkerRequest = {
    operation: options.operation,
    filePath: options.filePath,
    workspaceRoot: options.workspaceRoot,
    allowedRoots: [...options.allowedRoots],
    line: options.line,
    character: options.character,
    query: options.query,
    maxResults: options.maxResults
  };

  const worker = new Worker(resolveWorkerUrl(), {
    workerData: request
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const onAbort = () => {
      settle(() => {
        void worker.terminate();
        reject(new Error("LSP query aborted."));
      });
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

      settle(() => reject(new Error("LSP worker returned an invalid response.")));
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      settle(() => reject(
        new Error(
          code === 0
            ? "LSP worker exited before returning a result."
            : `LSP worker exited with code ${code}.`
        )
      ));
    };

    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_LSP_WORKER_TIMEOUT_MS);
    timeout = setTimeout(() => {
      settle(() => {
        void worker.terminate();
        reject(new Error(`LSP query timed out after ${timeoutMs}ms.`));
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

/**
 * Resolve the worker script for both:
 * - bundled layout: dist/app.cjs + dist/LspRuntimeWorker.cjs
 * - tsc/tsx layout: co-located .js next to this module or under dist/
 */
export function resolveWorkerUrl() {
  const candidates: URL[] = [];
  for (const fileName of WORKER_FILE_NAMES) {
    candidates.push(
      new URL(`./${fileName}`, import.meta.url),
      new URL(`../${fileName}`, import.meta.url),
      new URL(`../../${fileName}`, import.meta.url),
      new URL(`../../../dist/${fileName}`, import.meta.url),
      new URL(`../../../dist/services/lsp/${fileName}`, import.meta.url)
    );
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(fileURLToPath(candidate))) {
        return candidate;
      }
    } catch {
      // Ignore invalid/non-file URLs and keep trying.
    }
  }

  return candidates[0]!;
}

function isWorkerSuccessResponse(message: unknown): message is WorkerSuccessResponse {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { ok?: unknown }).ok === true &&
      "result" in (message as object)
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

