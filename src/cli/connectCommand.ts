import type { ConnectionConfigState } from "../config/runtime.js";
import {
  CONNECTABLE_PROVIDER_PRESET_IDS,
  DEFAULT_OLLAMA_BASE_URL,
  getBuiltInProviderProfile,
  isConnectableProviderPreset
} from "../core/providers/defaults.js";
import type { ProviderProfileInput } from "../core/providers/registry.js";
import { formatModelRef } from "../core/providers/resolveModel.js";
import type { ProviderProfile } from "../core/providers/types.js";

export interface ProviderConnectionPlan {
  providerId: string;
  model: string;
  displayModel: string;
  apiKey?: string;
  providerProfile?: ProviderProfileInput;
  summary: string;
  details: string[];
}

export type ConnectProviderResult =
  | {
      ok: true;
      plan: ProviderConnectionPlan;
    }
  | {
      ok: false;
      message: string;
      suggestions: string[];
    };

const DEFAULT_LOCAL_BASE_URL = DEFAULT_OLLAMA_BASE_URL;
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function formatConnectUsage(): string {
  const apiKeyPresets = CONNECTABLE_PROVIDER_PRESET_IDS
    .filter((providerId) => getBuiltInProviderProfile(providerId)?.kind !== "local")
    .join(", ");
  const localPresets = CONNECTABLE_PROVIDER_PRESET_IDS
    .filter((providerId) => getBuiltInProviderProfile(providerId)?.kind === "local")
    .join(", ");

  return [
    "Usage:",
    `- /connect <provider> <api-key> [model] [baseURL] for API-key presets: ${apiKeyPresets}`,
    `- /connect <provider> [baseURL] [model] for local presets: ${localPresets}`,
    "- /connect custom <provider-id> <baseURL> <model> <api-key> [label]",
    "",
    "Secrets are saved to ~/.alyce/auth.json. Provider profiles are saved without apiKey."
  ].join("\n");
}

export function resolveConnectProvider(
  provider: string | undefined,
  args: string[],
  options: {
    connectionState: ConnectionConfigState;
  }
): ConnectProviderResult {
  const providerName = provider?.trim().toLowerCase();
  if (!providerName) {
    return {
      ok: false,
      message: "Missing provider.",
      suggestions: [formatConnectUsage()]
    };
  }

  switch (providerName) {
    case "custom":
      return resolveCustomConnect(args, options.connectionState);
    default:
      if (isConnectableProviderPreset(providerName)) {
        return resolvePresetConnect(providerName, args, options.connectionState);
      }

      return {
        ok: false,
        message: `Unsupported provider for /connect: ${provider}`,
        suggestions: [
          `Supported providers: ${[...CONNECTABLE_PROVIDER_PRESET_IDS, "custom"].join(", ")}.`,
          formatConnectUsage()
        ]
      };
  }
}

export function normalizeLogoutProvider(provider: string | undefined): string | null {
  const normalized = provider?.trim().toLowerCase();
  return normalized || null;
}

function resolvePresetConnect(
  providerId: string,
  args: string[],
  connectionState: ConnectionConfigState
): ConnectProviderResult {
  const existing = connectionState.providerProfiles[providerId];
  const preset = existing ?? getBuiltInProviderProfile(providerId);
  if (!preset) {
    return {
      ok: false,
      message: `Unsupported provider for /connect: ${providerId}`,
      suggestions: [formatConnectUsage()]
    };
  }

  if (preset.kind === "local") {
    return resolveLocalPresetConnect(providerId, args, existing);
  }

  return resolveApiKeyPresetConnect(providerId, args, existing, preset);
}

function resolveApiKeyPresetConnect(
  providerId: string,
  args: string[],
  existing: ProviderProfile | undefined,
  preset: ProviderProfile
): ConnectProviderResult {
  const apiKey = args[0]?.trim();
  if (!apiKey) {
    return missingArgument(
      `Missing ${preset.label} API key.`,
      `/connect ${providerId} <api-key> [model] [baseURL]`
    );
  }

  const model = args[1]?.trim() || existing?.defaultModel || preset.defaultModel || "model";
  const baseURL = args[2]?.trim();
  const effectiveBaseURL = baseURL || existing?.baseURL || preset.baseURL;
  const urlError = effectiveBaseURL ? validateUrl(effectiveBaseURL) : null;
  if (urlError) {
    return {
      ok: false,
      message: urlError,
      suggestions: [`/connect ${providerId} sk-... ${model} ${preset.baseURL ?? "https://api.example.com/v1"}`]
    };
  }

  const displayModel = formatModelRef({ providerId, modelId: model });
  const shouldSaveProviderProfile =
    Boolean(baseURL && baseURL !== preset.baseURL) ||
    Boolean(existing && model !== existing.defaultModel);

  return {
    ok: true,
    plan: {
      providerId,
      model: providerId === "openai" ? model : displayModel,
      displayModel,
      apiKey,
      ...(shouldSaveProviderProfile
        ? {
            providerProfile: mergeModelIntoProfile(existing, {
              label: existing?.label ?? preset.label,
              kind: preset.kind,
              ...(effectiveBaseURL ? { baseURL: effectiveBaseURL } : {}),
              defaultModel: model
            }, model)
          }
        : {}),
      summary: `Connected ${preset.label} and switched to ${displayModel}.`,
      details: [
        "Saved API key to AuthStore.",
        effectiveBaseURL
          ? `Endpoint: ${effectiveBaseURL}`
          : "Using the provider SDK default endpoint.",
        shouldSaveProviderProfile
          ? "Saved provider profile without apiKey."
          : `Using the built-in ${preset.label} provider profile.`
      ]
    }
  };
}

function resolveLocalPresetConnect(
  providerId: string,
  args: string[],
  existing: ProviderProfile | undefined
): ConnectProviderResult {
  const preset = getBuiltInProviderProfile(providerId);
  const baseURL = args[0]?.trim() || existing?.baseURL || preset?.baseURL || DEFAULT_LOCAL_BASE_URL;
  const model = args[1]?.trim() || existing?.defaultModel || preset?.defaultModel || "local-model";
  const urlError = validateUrl(baseURL);
  if (urlError) {
    return {
      ok: false,
      message: urlError,
      suggestions: [`/connect ${providerId} ${DEFAULT_LOCAL_BASE_URL} qwen`]
    };
  }

  const displayModel = formatModelRef({ providerId, modelId: model });
  const shouldSaveProviderProfile =
    !preset?.baseURL ||
    baseURL !== preset.baseURL ||
    Boolean(existing && model !== existing.defaultModel);

  return {
    ok: true,
    plan: {
      providerId,
      model: displayModel,
      displayModel,
      ...(shouldSaveProviderProfile
        ? {
            providerProfile: mergeModelIntoProfile(existing, {
              label: existing?.label ?? preset?.label ?? providerId,
              kind: "local",
              baseURL,
              defaultModel: model
            }, model)
          }
        : {}),
      summary: `Connected ${preset?.label ?? providerId} local endpoint and switched to ${displayModel}.`,
      details: [
        `Endpoint: ${baseURL}`,
        "Local providers do not require an API key.",
        shouldSaveProviderProfile
          ? "Saved provider profile without apiKey."
          : `Using the built-in ${preset?.label ?? providerId} provider profile.`
      ]
    }
  };
}

function resolveCustomConnect(
  args: string[],
  connectionState: ConnectionConfigState
): ConnectProviderResult {
  const providerId = args[0]?.trim().toLowerCase();
  const baseURL = args[1]?.trim();
  const model = args[2]?.trim();
  const apiKey = args[3]?.trim();
  const label = args.slice(4).join(" ").trim();

  if (!providerId || !baseURL || !model || !apiKey) {
    return missingArgument(
      "Missing custom provider id, baseURL, model, or API key.",
      "/connect custom <provider-id> <baseURL> <model> <api-key> [label]"
    );
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
    return {
      ok: false,
      message: `Invalid custom provider id: ${providerId}`,
      suggestions: ["Use letters, numbers, dot, underscore, or dash. Provider ids cannot contain slash or spaces."]
    };
  }
  if (getBuiltInProviderProfile(providerId)) {
    return {
      ok: false,
      message: `Provider '${providerId}' is built in. Use /connect ${providerId} when available or choose a custom id.`,
      suggestions: ["Example: /connect custom company-openai https://proxy.example/v1 gpt-5.2 sk-..."]
    };
  }

  const urlError = validateUrl(baseURL);
  if (urlError) {
    return {
      ok: false,
      message: urlError,
      suggestions: ["Example: /connect custom company-openai https://proxy.example/v1 gpt-5.2 sk-..."]
    };
  }

  const existing = connectionState.providerProfiles[providerId];
  const displayModel = formatModelRef({ providerId, modelId: model });
  return {
    ok: true,
    plan: {
      providerId,
      model: displayModel,
      displayModel,
      apiKey,
      providerProfile: mergeModelIntoProfile(existing, {
        label: label || existing?.label || providerId,
        kind: "openai-compatible",
        baseURL,
        defaultModel: model
      }, model),
      summary: `Connected custom provider '${providerId}' and switched to ${displayModel}.`,
      details: [
        `Endpoint: ${baseURL}`,
        "Saved API key to AuthStore.",
        "Saved provider profile without apiKey."
      ]
    }
  };
}

function mergeModelIntoProfile(
  existing: ProviderProfile | undefined,
  patch: ProviderProfileInput,
  model: string
): ProviderProfileInput {
  return {
    ...patch,
    models: {
      ...(existing?.models ?? {}),
      [model]: {
        ...(existing?.models?.[model] ?? {})
      }
    }
  };
}

function missingArgument(message: string, usage: string): ConnectProviderResult {
  return {
    ok: false,
    message,
    suggestions: [
      usage,
      "Run /connect with the API key as an argument; it will be saved to ~/.alyce/auth.json."
    ]
  };
}

function validateUrl(value: string): string | null {
  try {
    new URL(value);
    return null;
  } catch {
    return `Invalid baseURL: ${value}`;
  }
}
