import type { McpToolRuntime } from "../../mcp/types.js";
import type {
  BackgroundProcessManagerLike,
  PtyManagerLike
} from "../../tools/types.js";
import type { ChatCompletionAdapter } from "../../core/api/modelAdapters.js";
import type { ResolvedModelProfile } from "../../core/providers/types.js";
import { measureStartupTiming } from "../../core/startup/startupTiming.js";

interface LazyProjectMcpRuntimeOptions {
  homeDirectory?: string;
  outputDirectory?: string;
  trusted?: boolean;
}

type McpInteractionHandlers = Parameters<NonNullable<McpToolRuntime["setInteractionHandlers"]>>[0];

export function createLazyProjectMcpRuntime(
  workspaceRoot: string,
  options: LazyProjectMcpRuntimeOptions = {}
): McpToolRuntime {
  let runtimePromise: Promise<McpToolRuntime> | undefined;
  let loadedRuntime: McpToolRuntime | undefined;
  let interactionHandlers: McpInteractionHandlers | undefined;
  let trusted = options.trusted !== false;

  const getRuntime = async () => {
    if (!runtimePromise) {
      runtimePromise = measureStartupTiming("sessionRuntime:loadProjectMcpRuntime", async () => {
        const { createProjectMcpRuntime } = await import("../../mcp/runtime.js");
        const runtime = await createProjectMcpRuntime(workspaceRoot, {
          ...options,
          trusted
        });
        if (interactionHandlers) {
          runtime.setInteractionHandlers?.(interactionHandlers);
        }
        loadedRuntime = runtime;
        return runtime;
      });
    }

    return runtimePromise;
  };

  return {
    getToolSchemas: async (requestOptions = {}) => {
      if (requestOptions.initialize === false && !runtimePromise) {
        return [];
      }

      return (await getRuntime()).getToolSchemas(requestOptions);
    },
    canExecuteTool: (toolName) => {
      return loadedRuntime?.canExecuteTool(toolName) ?? false;
    },
    executeNamedToolCall: async (...args) =>
      (await getRuntime()).executeNamedToolCall(...args),
    executeToolCall: async (...args) =>
      (await getRuntime()).executeToolCall(...args),
    getStatus: async (requestOptions = {}) => {
      if (requestOptions.initialize === false && !runtimePromise) {
        return {
          servers: [],
          message: "MCP runtime has not been loaded yet."
        };
      }

      return (await getRuntime()).getStatus(requestOptions);
    },
    listTools: async (requestOptions = {}) =>
      (await getRuntime()).listTools(requestOptions),
    listResources: async (requestOptions = {}) =>
      (await getRuntime()).listResources(requestOptions),
    listPrompts: async (requestOptions = {}) =>
      (await getRuntime()).listPrompts(requestOptions),
    getPrompt: async (...args) =>
      (await getRuntime()).getPrompt(...args),
    listResourceTemplates: async (requestOptions = {}) =>
      (await getRuntime()).listResourceTemplates(requestOptions),
    readResource: async (...args) =>
      (await getRuntime()).readResource(...args),
    reloadConfig: async () =>
      (await getRuntime()).reloadConfig(),
    setProjectTrusted: async (nextTrusted) => {
      trusted = nextTrusted;
      if (runtimePromise) {
        await (await getRuntime()).setProjectTrusted?.(nextTrusted);
      }
    },
    addServer: async (...args) =>
      (await getRuntime()).addServer(...args),
    removeServer: async (...args) =>
      (await getRuntime()).removeServer(...args),
    setServerEnabled: async (...args) =>
      (await getRuntime()).setServerEnabled(...args),
    loginServer: async (...args) =>
      (await getRuntime()).loginServer(...args),
    setInteractionHandlers: (handlers) => {
      interactionHandlers = handlers;
      if (runtimePromise) {
        void runtimePromise.then((runtime) => {
          runtime.setInteractionHandlers?.(handlers);
        });
      }
    },
    close: async () => {
      if (!runtimePromise) {
        return;
      }

      await (await runtimePromise).close();
    }
  };
}

export function createLazyBackgroundProcessManager(options: {
  workspaceRoot: string;
  storageRoot: string;
}): BackgroundProcessManagerLike {
  let managerPromise: Promise<BackgroundProcessManagerLike> | undefined;
  let loadedManager: BackgroundProcessManagerLike | undefined;

  const getManager = async () => {
    if (!managerPromise) {
      managerPromise = measureStartupTiming("sessionRuntime:loadBackgroundProcessManager", async () => {
        const { BackgroundProcessManager } = await import("../../core/background-process/backgroundProcessManager.js");
        loadedManager = new BackgroundProcessManager(options);
        return loadedManager;
      });
    }

    return managerPromise;
  };

  return {
    startProcess: async (startOptions: Parameters<BackgroundProcessManagerLike["startProcess"]>[0]) =>
      (await getManager()).startProcess(startOptions),
    listProcesses: (listOptions: Parameters<BackgroundProcessManagerLike["listProcesses"]>[0] = {}) =>
      loadedManager?.listProcesses(listOptions) ?? [],
    getProcess: (processId: string) => loadedManager?.getProcess(processId),
    readProcessLog: async (
      processId: string,
      readOptions: Parameters<BackgroundProcessManagerLike["readProcessLog"]>[1] = {}
    ) =>
      (await getManager()).readProcessLog(processId, readOptions),
    stopProcess: async (
      processId: string,
      stopOptions: Parameters<BackgroundProcessManagerLike["stopProcess"]>[1] = {}
    ) => (await getManager()).stopProcess(processId, stopOptions),
    stopAll: async (
      stopOptions: Parameters<BackgroundProcessManagerLike["stopAll"]>[0] = {}
    ) => (await getManager()).stopAll(stopOptions)
  };
}

export function createLazyPtyManager(options: {
  workspaceRoot: string;
}): PtyManagerLike {
  let managerPromise: Promise<PtyManagerLike> | undefined;
  let loadedManager: PtyManagerLike | undefined;

  const getManager = async () => {
    if (!managerPromise) {
      managerPromise = measureStartupTiming("sessionRuntime:loadPtyManager", async () => {
        const { PtyManager } = await import("../../core/pty/ptyManager.js");
        loadedManager = new PtyManager(options);
        return loadedManager;
      });
    }

    return managerPromise;
  };

  return {
    createSession: (createOptions: Parameters<PtyManagerLike["createSession"]>[0] = {}) =>
      loadedManager?.createSession(createOptions) ?? (() => {
        throw new Error("PTY manager has not been loaded yet.");
      })(),
    listSessions: () => loadedManager?.listSessions() ?? [],
    getSession: (id: string) => loadedManager?.getSession(id),
    readSession: (
      id: string,
      readOptions: Parameters<PtyManagerLike["readSession"]>[1] = {}
    ) =>
      loadedManager?.readSession(id, readOptions) ?? (() => {
        throw new Error("PTY manager has not been loaded yet.");
      })(),
    writeSession: (id: string, data: string) =>
      loadedManager?.writeSession(id, data) ?? (() => {
        throw new Error("PTY manager has not been loaded yet.");
      })(),
    resizeSession: (id: string, cols: number, rows: number) =>
      loadedManager?.resizeSession(id, cols, rows) ?? (() => {
        throw new Error("PTY manager has not been loaded yet.");
      })(),
    closeSession: (id: string) =>
      loadedManager?.closeSession(id) ?? (() => {
        throw new Error("PTY manager has not been loaded yet.");
      })(),
    closeAll: () => loadedManager?.closeAll() ?? []
  };
}

export function createLazyModelAdapter(resolvedModel: ResolvedModelProfile): ChatCompletionAdapter {
  let adapterPromise: Promise<ChatCompletionAdapter> | undefined;

  const getAdapter = async () => {
    if (!adapterPromise) {
      adapterPromise = measureStartupTiming("sessionRuntime:loadModelAdapter", async () => {
        const { createModelAdapter } = await import("../../core/api/modelAdapters.js");
        return createModelAdapter(resolvedModel);
      });
    }

    return adapterPromise;
  };

  return {
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    kind: resolvedModel.kind,
    sendChatCompletion: async (request, options) =>
      (await getAdapter()).sendChatCompletion(request, options)
  };
}




