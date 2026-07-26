import type { McpToolRuntime } from "../../mcp/types.js";
import type {
  BackgroundProcessManagerLike,
  PtyManagerLike
} from "../../tools/types.js";
import type { ChatCompletionAdapter } from "../../core/api/modelAdapters.js";
import type { ResolvedModelProfile } from "../../core/providers/types.js";
import { measureStartupTiming } from "../../core/startup/startupTiming.js";
import { PtyManager } from "../../core/pty/ptyManager.js";

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

/**
 * PtyManager 的构造是同步且廉价的（构造函数只做两次赋值），而真正重的
 * `@lydell/node-pty` 是在 PtyManager 内部首次 spawn 时才 require 的。所以这里
 * 不需要异步 import：只把「实例化」推迟到首次使用即可，值钱的那部分惰性仍然保留。
 *
 * 早先的实现用 `await import()` 配合 `loadedManager?.x ?? throw`，但那个 loader
 * 从未被调用，`loadedManager` 因此永远是 undefined —— 五个 PTY 工具全部不可用。
 */
export function createLazyPtyManager(options: {
  workspaceRoot: string;
}): PtyManagerLike {
  let loadedManager: PtyManagerLike | undefined;

  const getManager = (): PtyManagerLike => {
    loadedManager ??= new PtyManager(options);
    return loadedManager;
  };

  return {
    createSession: (createOptions: Parameters<PtyManagerLike["createSession"]>[0] = {}) =>
      getManager().createSession(createOptions),
    listSessions: () => getManager().listSessions(),
    getSession: (id: string) => getManager().getSession(id),
    readSession: (
      id: string,
      readOptions: Parameters<PtyManagerLike["readSession"]>[1] = {}
    ) => getManager().readSession(id, readOptions),
    writeSession: (id: string, data: string) => getManager().writeSession(id, data),
    resizeSession: (id: string, cols: number, rows: number) =>
      getManager().resizeSession(id, cols, rows),
    closeSession: (id: string) => getManager().closeSession(id),
    // 关闭全部时不要顺手实例化：从没用过 PTY 的会话退出时应当是空操作。
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




