import { setTimeout as sleep } from "node:timers/promises";
import type { ProviderAuthRecordInput } from "../../auth/authStore.js";
import { sleepWithAbort, throwIfAuthCancelled } from "../authFlowUtils.js";
import type { ProviderConnector } from "../providerAuth.js";
import type { ModelProfile, ProviderProfile } from "../types.js";

const CLIENT_ID = "Ov23lifo23d1GEpDddQc";
const POLLING_SAFETY_MARGIN_MS = 3000;

export interface GitHubCopilotConnectorOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  pollingSafetyMarginMs?: number;
}

export function createGitHubCopilotConnector(
  options: GitHubCopilotConnectorOptions = {}
): ProviderConnector {
  const fetchImpl = options.fetch ?? fetch;
  const sleepImpl = options.sleep ?? sleep;
  return {
    id: "github-copilot",
    label: "GitHub Copilot",
    experimental: true,
    auth: {
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                { label: "GitHub.com", value: "github.com", hint: "Public GitHub" },
                { label: "GitHub Enterprise", value: "enterprise", hint: "Enterprise domain" }
              ]
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" }
            }
          ],
          authorize: async (inputs = {}) => {
            const deploymentType = inputs.deploymentType || "github.com";
            const domain = deploymentType === "enterprise"
              ? normalizeDomain(inputs.enterpriseUrl ?? "")
              : "github.com";
            if (!domain) {
              throw new Error("GitHub Enterprise domain is required.");
            }

            const urls = getGitHubDeviceUrls(domain);
            const device = await requestGitHubDeviceCode(fetchImpl, urls.deviceCodeUrl);
            return {
              method: "auto",
              url: device.verification_uri,
              instructions: `Enter code: ${device.user_code}`,
              callback: (callbackOptions) => pollGitHubDeviceToken({
                fetchImpl,
                sleepImpl,
                accessTokenUrl: urls.accessTokenUrl,
                deviceCode: device.device_code,
                intervalSeconds: device.interval,
                enterpriseUrl: deploymentType === "enterprise" ? domain : undefined,
                maxPolls: options.maxPolls,
                pollingSafetyMarginMs: options.pollingSafetyMarginMs,
                abortSignal: callbackOptions?.signal
              })
            };
          }
        }
      ],
      loader: async ({ getAuth }) => {
        const auth = await getAuth();
        if (!auth || auth.type !== "oauth") {
          return {};
        }

        return {
          apiKey: auth.accessToken,
          baseURL: "https://api.githubcopilot.com",
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "Openai-Intent": "conversation-edits",
            "x-initiator": "user"
          }
        };
      }
    },
    models: async ({ provider, auth, signal }) => fetchGitHubCopilotModels({
      provider,
      accessToken: auth?.type === "oauth" ? auth.refreshToken || auth.accessToken : provider.apiKey,
      fetchImpl,
      signal
    })
  };
}

export async function fetchGitHubCopilotModels(options: {
  provider: ProviderProfile;
  accessToken?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Record<string, ModelProfile>> {
  const token = options.accessToken?.trim();
  if (!token) {
    throw new Error("GitHub Copilot model list requires an OAuth token.");
  }

  const baseURL = options.provider.baseURL?.trim() || "https://api.githubcopilot.com";
  const response = await (options.fetchImpl ?? fetch)(`${baseURL.replace(/\/+$/, "")}/models`, {
    method: "GET",
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "alyce/github-copilot"
    },
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`GitHub Copilot model list request failed: HTTP ${response.status}`);
  }

  return parseGitHubCopilotModels(await response.json());
}

export function parseGitHubCopilotModels(input: unknown): Record<string, ModelProfile> {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  if (!Array.isArray(record.data)) {
    throw new Error("GitHub Copilot model list response is missing data array.");
  }

  const models: Record<string, ModelProfile> = {};
  for (const item of record.data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const model = item as Record<string, unknown>;
    if (model.model_picker_enabled !== true) {
      continue;
    }

    const id = typeof model.id === "string" && model.id.trim() ? model.id.trim() : "";
    if (!id) {
      continue;
    }

    const capabilities = model.capabilities && typeof model.capabilities === "object" && !Array.isArray(model.capabilities)
      ? model.capabilities as Record<string, unknown>
      : {};
    const limits = capabilities.limits && typeof capabilities.limits === "object" && !Array.isArray(capabilities.limits)
      ? capabilities.limits as Record<string, unknown>
      : {};
    const contextWindow = positiveInteger(limits.max_context_window_tokens);
    const maxOutputTokens = positiveInteger(limits.max_output_tokens);
    const label = typeof model.name === "string" && model.name.trim()
      ? model.name.trim()
      : id;
    models[id] = {
      label,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
    };
  }

  return models;
}

export function normalizeDomain(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function getGitHubDeviceUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`
  };
}

async function requestGitHubDeviceCode(fetchImpl: typeof fetch, url: string) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "alyce/github-copilot-experimental"
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user"
    })
  });
  if (!response.ok) {
    throw new Error(`GitHub device authorization failed: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    verification_uri?: string;
    user_code?: string;
    device_code?: string;
    interval?: number;
  };
  if (!data.verification_uri || !data.user_code || !data.device_code) {
    throw new Error("GitHub device authorization response was missing required fields.");
  }

  return {
    verification_uri: data.verification_uri,
    user_code: data.user_code,
    device_code: data.device_code,
    interval: data.interval ?? 5
  };
}

async function pollGitHubDeviceToken(options: {
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  accessTokenUrl: string;
  deviceCode: string;
  intervalSeconds: number;
  enterpriseUrl?: string;
  maxPolls?: number;
  pollingSafetyMarginMs?: number;
  abortSignal?: AbortSignal;
}): Promise<ProviderAuthRecordInput> {
  let attempts = 0;
  let intervalMs = options.intervalSeconds * 1000;
  const safetyMs = options.pollingSafetyMarginMs ?? POLLING_SAFETY_MARGIN_MS;
  while (options.maxPolls === undefined || attempts < options.maxPolls) {
    throwIfAuthCancelled(options.abortSignal);
    attempts += 1;
    const response = await options.fetchImpl(options.accessTokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "alyce/github-copilot-experimental"
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: options.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      }),
      signal: options.abortSignal
    });
    const data = await response.json() as {
      access_token?: string;
      error?: string;
      interval?: number;
    };

    if (data.access_token) {
      return {
        type: "oauth",
        accessToken: data.access_token,
        refreshToken: data.access_token,
        expiresAt: 0,
        ...(options.enterpriseUrl ? { extra: { enterpriseUrl: options.enterpriseUrl } } : {})
      };
    }

    if (data.error === "slow_down") {
      intervalMs = (data.interval ?? options.intervalSeconds + 5) * 1000;
    } else if (data.error && data.error !== "authorization_pending") {
      throw new Error(`GitHub device authorization failed: ${data.error}`);
    }

    await sleepWithAbort(options.sleepImpl, intervalMs + safetyMs, options.abortSignal);
  }

  throw new Error("GitHub device authorization polling timed out.");
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}
