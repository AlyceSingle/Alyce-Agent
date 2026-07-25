import {
  type ConnectionConfigLayer,
  type ConnectionConfigState,
  type SessionSettingsState
} from "../../../config/runtime.js";
import {
  applyProviderAuthRecords,
  type ProviderAuthMap
} from "../../../core/auth/authStore.js";
import { cloneJson } from "../../../core/json/clone.js";
import type { ProviderProfileInput } from "../../../core/providers/registry.js";
import type { ModelProfile, ProviderProfileMap } from "../../../core/providers/types.js";

export function mergePersistedSource<T extends object>(base: Partial<T>, patch: Partial<T>): Partial<T> {
  const next = { ...base } as Partial<T>;

  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value === undefined) {
      delete next[key];
      continue;
    }

    next[key] = value;
  }

  return next;
}

export function mergeUserProviderProfile(
  user: ConnectionConfigLayer,
  providerId: string,
  profile: ProviderProfileInput
): ConnectionConfigLayer {
  const providers = cloneJson(user.providers ?? {});
  const existing = providers[providerId] ?? {};
  providers[providerId] = {
    ...existing,
    ...profile,
    models: {
      ...(existing.models ?? {}),
      ...(profile.models ?? {})
    }
  };

  return {
    ...user,
    providers
  };
}

export function applyAuthToConnectionState(
  state: ConnectionConfigState,
  authRecords: ProviderAuthMap
): ConnectionConfigState {
  return {
    ...state,
    providerProfiles: applyProviderAuthRecords(state.providerProfiles, authRecords)
  };
}

export function applyRuntimeProviderModelOverrides(
  state: ConnectionConfigState,
  overrides: Record<string, Record<string, ModelProfile>>
): ConnectionConfigState {
  const providerProfiles: ProviderProfileMap = { ...state.providerProfiles };
  for (const [providerId, models] of Object.entries(overrides)) {
    const provider = providerProfiles[providerId];
    if (!provider) {
      continue;
    }

    providerProfiles[providerId] = {
      ...provider,
      models: mergeRuntimeModelProfiles(provider.models ?? {}, models)
    };
  }

  return {
    ...state,
    providerProfiles
  };
}

function mergeRuntimeModelProfiles(
  existing: Record<string, ModelProfile>,
  discovered: Record<string, ModelProfile>
): Record<string, ModelProfile> {
  const merged: Record<string, ModelProfile> = {};
  for (const [modelId, profile] of Object.entries(discovered)) {
    merged[modelId] = {
      ...(existing[modelId] ?? {}),
      ...profile
    };
  }

  return merged;
}

export function cloneConnectionConfigState(state: ConnectionConfigState): ConnectionConfigState {
  return {
    effective: { ...state.effective },
    user: cloneJson(state.user),
    project: cloneJson(state.project),
    env: { ...state.env },
    cli: { ...state.cli },
    sources: { ...state.sources },
    providerProfiles: cloneJson(state.providerProfiles),
    saveTarget: state.saveTarget,
    saveTargetPath: state.saveTargetPath,
    userPath: state.userPath,
    projectPath: state.projectPath
  };
}

export function cloneSessionSettingsState(state: SessionSettingsState): SessionSettingsState {
  return {
    effective: cloneJson(state.effective),
    project: cloneJson(state.project),
    user: cloneJson(state.user),
    env: cloneJson(state.env),
    cli: cloneJson(state.cli),
    sources: { ...state.sources },
    saveTargetPath: state.saveTargetPath,
    projectPath: state.projectPath
  };
}
