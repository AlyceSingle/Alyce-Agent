import { parentPort, workerData } from "node:worker_threads";
import { executeLspRuntimeQuery } from "./LspRuntimeService.js";
import type {
  LspRuntimeQueryInput,
  LspRuntimeQueryResult
} from "./types.js";

type WorkerRequest = Omit<LspRuntimeQueryInput, "abortSignal">;

type WorkerSuccessResponse = {
  ok: true;
  result: LspRuntimeQueryResult;
};

type WorkerFailureResponse = {
  ok: false;
  error: string;
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertWorkerPort() {
  if (!parentPort) {
    throw new Error("LspRuntimeWorker must be started as a worker thread.");
  }

  return parentPort;
}

async function run() {
  const port = assertWorkerPort();
  const request = workerData as WorkerRequest;

  try {
    const result = await executeLspRuntimeQuery(request);
    const response: WorkerSuccessResponse = {
      ok: true,
      result
    };
    port.postMessage(response);
  } catch (error) {
    const response: WorkerFailureResponse = {
      ok: false,
      error: formatError(error)
    };
    port.postMessage(response);
  }
}

void run();
