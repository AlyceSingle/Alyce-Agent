import type { ResolvedModelProfile } from "../providers/types.js";

export interface ModelAdapterAvailability {
  available: boolean;
  reason?: string;
}

export function getModelAdapterAvailability(
  resolvedModel: ResolvedModelProfile
): ModelAdapterAvailability {
  if (resolvedModel.kind === "local" && !resolvedModel.baseURL) {
    return {
      available: false,
      reason: `Provider '${resolvedModel.providerId}' is local and requires a baseURL for its OpenAI-compatible endpoint.`
    };
  }

  if (!resolvedModel.apiKey && resolvedModel.kind !== "local") {
    const envHint = resolvedModel.apiKeyEnv ? ` or set ${resolvedModel.apiKeyEnv}` : "";
    return {
      available: false,
      reason: `Provider '${resolvedModel.providerId}' is missing an API key. Configure apiKey${envHint}.`
    };
  }

  return {
    available: true
  };
}
