import {
  buildConnectionConfigState,
  buildSessionSettingsState,
  saveConnectionConfig,
  saveUserSessionSettings,
  type ConnectionConfig,
  type ConnectionConfigLayer,
  type ConnectionConfigSaveTarget,
  type ConnectionConfigState,
  type RuntimeConfig,
  type SessionSettings,
  type SessionSettingsState
} from "../../config/runtime.js";
import {
  AuthStore,
  type ProviderAuthMap
} from "../../core/auth/authStore.js";
import { getModelAdapterAvailability } from "../../core/api/modelAdapterAvailability.js";
import { cloneJson } from "../../core/json/clone.js";
import { parseModelRef, resolveModelProfile } from "../../core/providers/resolveModel.js";
import { ProviderAuthService, type AuthFlow } from "../../core/providers/providerAuth.js";
import {
  refreshProviderModels,
  type ProviderModelRefreshResult
} from "../../core/providers/modelDiscovery.js";
import type { ModelProfile, ModelRef, ResolvedModelProfile } from "../../core/providers/types.js";
import type { ProviderConnectionPlan } from "../connectCommand.js";
import {
  applyAuthToConnectionState,
  applyRuntimeProviderModelOverrides,
  cloneConnectionConfigState,
  cloneSessionSettingsState,
  mergePersistedSource,
  mergeUserProviderProfile,
  normalizeConnectionPatch,
  normalizeSettingsPatch
} from "./helpers/index.js";

export interface ConnectionControllerDeps {
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  authStore: AuthStore;
  onAfterConnectionChange: () => Promise<void>;
  onAfterSettingsChange: (settings: SessionSettings) => Promise<void>;
}

export interface ConnectionController {
  getConnection: () => ConnectionConfig;
  getEffectiveConnection: () => ConnectionConfig;
  getConnectionState: () => ConnectionConfigState;
  getSettings: () => SessionSettings;
  getEffectiveSettings: () => SessionSettings;
  getSettingsState: () => SessionSettingsState;
  getAuthStore: () => AuthStore;
  getProviderAuthRecords: () => ProviderAuthMap;
  getAuthStorePath: () => string;
  resolveModelProfileFor: (model?: string) => ResolvedModelProfile;
  hasUsableModelAdapter: () => boolean;
  getCurrentModel: () => string;
  getCurrentModelRef: () => ModelRef;
  setCurrentModel: (model: string) => Promise<void>;
  updateConnectionConfig: (
    patch: Partial<ConnectionConfig>,
    target?: ConnectionConfigSaveTarget
  ) => Promise<void>;
  applyProviderConnection: (plan: ProviderConnectionPlan) => Promise<void>;
  authorizeProviderAuth: (
    providerId: string,
    methodIndex: number,
    inputs?: Record<string, string>
  ) => Promise<
    | { type: "stored"; providerId: string; model: string }
    | { type: "flow"; flow: AuthFlow }
  >;
  completeProviderAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
    options?: { signal?: AbortSignal }
  ) => Promise<{ providerId: string; model: string }>;
  clearProviderAuthFlow: (providerId?: string) => void;
  removeProviderAuth: (providerId: string) => Promise<boolean>;
  refreshCurrentProviderModels: () => Promise<ProviderModelRefreshResult>;
  updateSettings: (patch: Partial<SessionSettings>) => Promise<void>;
  persistSettings: () => Promise<void>;
}

export function createConnectionController(deps: ConnectionControllerDeps): ConnectionController {
  const { config, env, authStore, onAfterConnectionChange, onAfterSettingsChange } = deps;
  const providerAuthService = new ProviderAuthService(config.providerConnectors, authStore);
  let runtimeProviderModelOverrides: Record<string, Record<string, ModelProfile>> = {};
  // 运行时维护一份可变快照，避免直接在初始配置对象上原地修改。
  let connectionState = applyRuntimeProviderModelOverrides(
    applyAuthToConnectionState(
      cloneConnectionConfigState(config.connectionState),
      authStore.all()
    ),
    runtimeProviderModelOverrides
  );
  let settingsState = cloneSessionSettingsState(config.settingsState);
  let connection = connectionState.effective;
  let settings = settingsState.effective;
  let connectionSaveTarget = connectionState.saveTarget;

  const rebuildConnectionState = (options: {
    user?: ConnectionConfigLayer;
    project?: ConnectionConfigLayer;
    preferredSaveTarget?: ConnectionConfigSaveTarget;
  }) => {
    connectionState = applyRuntimeProviderModelOverrides(
      applyAuthToConnectionState(
        buildConnectionConfigState(config.paths, {
          user: options.user ?? connectionState.user,
          project: options.project ?? connectionState.project,
          env: connectionState.env,
          cli: connectionState.cli,
          pluginProviders: config.providerPluginProfiles,
          preferredSaveTarget: options.preferredSaveTarget ?? connectionSaveTarget
        }),
        authStore.all()
      ),
      runtimeProviderModelOverrides
    );
    connection = connectionState.effective;
    connectionSaveTarget = connectionState.saveTarget;
  };

  const persistConnection = async (target: ConnectionConfigSaveTarget) => {
    await saveConnectionConfig(
      config.paths,
      target,
      target === "project" ? connectionState.project : connectionState.user
    );
  };

  const persistSettings = async () => {
    await saveUserSessionSettings(config.paths, settingsState.user);
  };

  const resolveModelProfileFor = (model = connection.model) =>
    resolveModelProfile(model, {
      providers: connectionState.providerProfiles,
      modelContextWindowOverrides: settings.modelContextWindowOverrides,
      env
    });

  const hasUsableModelAdapter = () => {
    try {
      return getModelAdapterAvailability(resolveModelProfileFor()).available;
    } catch {
      return false;
    }
  };

  const applyConnectionPatch = async (
    patch: Partial<ConnectionConfig>,
    target = connectionSaveTarget
  ) => {
    // 任何连接更新都重新走一遍"分层合并 -> 归一化 -> 重建 client"的全流程，
    // 保证 effective / sources / saveTarget 始终一致。
    const sourcePatch = normalizeConnectionPatch(patch, connection);
    rebuildConnectionState({
      user:
        target === "user"
          ? mergePersistedSource(connectionState.user, sourcePatch)
          : connectionState.user,
      project:
        target === "project"
          ? mergePersistedSource(connectionState.project, sourcePatch)
          : connectionState.project,
      preferredSaveTarget: target
    });

    if (Object.keys(sourcePatch).length > 0) {
      await persistConnection(target);
    }

    await onAfterConnectionChange();
  };

  const applyProviderConnection = async (plan: ProviderConnectionPlan) => {
    if (plan.apiKey) {
      await authStore.set(plan.providerId, {
        type: "api",
        apiKey: plan.apiKey
      });
    }

    let nextUser = connectionState.user;
    if (plan.providerProfile) {
      nextUser = mergeUserProviderProfile(nextUser, plan.providerId, plan.providerProfile);
    }

    const sourcePatch = normalizeConnectionPatch({ model: plan.model }, connection);
    nextUser = mergePersistedSource(nextUser, sourcePatch);
    rebuildConnectionState({
      user: nextUser,
      preferredSaveTarget: "user"
    });
    await persistConnection("user");
    await onAfterConnectionChange();
  };

  const applyProviderAuthConnection = async (providerId: string) => {
    const normalizedProviderId = providerId.trim().toLowerCase();
    rebuildConnectionState({});
    const provider = connectionState.providerProfiles[normalizedProviderId];
    if (!provider) {
      throw new Error(`Provider '${normalizedProviderId}' is not configured.`);
    }

    const modelId = provider.defaultModel ?? Object.keys(provider.models ?? {})[0];
    if (!modelId) {
      throw new Error(`Provider '${normalizedProviderId}' does not define a default model.`);
    }

    const model = `${normalizedProviderId}/${modelId}`;
    const sourcePatch = normalizeConnectionPatch({ model }, connection);
    const nextUser = mergePersistedSource(connectionState.user, sourcePatch);
    rebuildConnectionState({
      user: nextUser,
      preferredSaveTarget: "user"
    });
    await persistConnection("user");
    await onAfterConnectionChange();
    return {
      providerId: normalizedProviderId,
      model
    };
  };

  const authorizeProviderAuth = async (
    providerId: string,
    methodIndex: number,
    inputs: Record<string, string> = {}
  ) => {
    const result = await providerAuthService.authorize(providerId, methodIndex, inputs);
    if (result.type === "flow") {
      return result;
    }

    return {
      type: "stored" as const,
      ...await applyProviderAuthConnection(providerId)
    };
  };

  const completeProviderAuth = async (
    providerId: string,
    methodIndex: number,
    code?: string,
    options: { signal?: AbortSignal } = {}
  ) => {
    await providerAuthService.callback(providerId, methodIndex, code, options);
    return applyProviderAuthConnection(providerId);
  };

  const refreshCurrentProviderModels = async (): Promise<ProviderModelRefreshResult> => {
    const modelRef = parseModelRef(connection.model);
    const provider = connectionState.providerProfiles[modelRef.providerId];
    if (!provider) {
      throw new Error(`Unknown provider: ${modelRef.providerId}`);
    }

    const result = await refreshProviderModels({
      provider,
      auth: authStore.get(provider.id),
      connector: providerAuthService.connector(provider.id),
      env
    });
    if (result.source === "live") {
      runtimeProviderModelOverrides = {
        ...runtimeProviderModelOverrides,
        [provider.id]: result.models
      };
      rebuildConnectionState({});
    }

    return result;
  };

  const removeProviderAuth = async (providerId: string) => {
    const removed = await authStore.remove(providerId);
    providerAuthService.clearPending(providerId);
    rebuildConnectionState({});
    await onAfterConnectionChange();
    return removed;
  };

  const updateSettings = async (patch: Partial<SessionSettings>) => {
    const userPatch = normalizeSettingsPatch(patch, config.paths.workspaceRoot);
    // 会话设置只回写 user 层；project / env / cli 仍然参与最终覆盖，但不会被保存动作覆盖掉。
    settingsState = buildSessionSettingsState(config.paths, {
      project: settingsState.project,
      user: mergePersistedSource(settingsState.user, userPatch),
      env: settingsState.env,
      cli: settingsState.cli
    });
    settings = settingsState.effective;
    await persistSettings();
    await onAfterSettingsChange(settings);
  };

  return {
    getConnection: () => ({ ...connection }),
    getEffectiveConnection: () => connection,
    getConnectionState: () => cloneConnectionConfigState(connectionState),
    getSettings: () => cloneJson(settings),
    getEffectiveSettings: () => settings,
    getSettingsState: () => cloneSessionSettingsState(settingsState),
    getAuthStore: () => authStore,
    getProviderAuthRecords: () => authStore.all(),
    getAuthStorePath: () => authStore.getPath(),
    resolveModelProfileFor,
    hasUsableModelAdapter,
    getCurrentModel: () => connection.model,
    getCurrentModelRef: () => parseModelRef(connection.model),
    setCurrentModel: async (model) => {
      await applyConnectionPatch({ model });
    },
    updateConnectionConfig: async (patch, target) => {
      await applyConnectionPatch(patch, target);
    },
    applyProviderConnection,
    authorizeProviderAuth,
    completeProviderAuth,
    clearProviderAuthFlow: (providerId) => {
      providerAuthService.clearPending(providerId);
    },
    removeProviderAuth,
    refreshCurrentProviderModels,
    updateSettings,
    persistSettings
  };
}
