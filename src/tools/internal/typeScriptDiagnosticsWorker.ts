import { parentPort, workerData } from "node:worker_threads";
import { getTypeScriptDiagnosticsForFile } from "./typeScriptDiagnostics.js";

type WorkerRequest = {
  fileName: string;
  workspaceRoot: string;
  allowedRoots: string[];
};

type WorkerSuccessResponse = {
  ok: true;
  result: Awaited<ReturnType<typeof getTypeScriptDiagnosticsForFile>>;
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
    throw new Error("typeScriptDiagnosticsWorker must be started as a worker thread.");
  }

  return parentPort;
}

async function run() {
  const port = assertWorkerPort();
  const request = workerData as WorkerRequest;

  try {
    const result = await getTypeScriptDiagnosticsForFile({
      fileName: request.fileName,
      workspaceRoot: request.workspaceRoot,
      allowedRoots: request.allowedRoots
    });
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
