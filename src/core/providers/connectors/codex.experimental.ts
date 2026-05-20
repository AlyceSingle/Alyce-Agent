import { setTimeout as sleep } from "node:timers/promises";
import type {
  OAuthAuthRecord,
  ProviderAuthRecordInput
} from "../../auth/authStore.js";
import { sleepWithAbort, throwIfAuthCancelled } from "../authFlowUtils.js";
import type { ProviderConnector } from "../providerAuth.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
const POLLING_SAFETY_MARGIN_MS = 3000;

export interface CodexConnectorOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  pollingSafetyMarginMs?: number;
  randomBytes?: (length: number) => Uint8Array;
}

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface CodexTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

type CodexRequestInput = string | URL | { url: string };

export function createCodexConnector(options: CodexConnectorOptions = {}): ProviderConnector {
  const fetchImpl = options.fetch ?? fetch;
  const sleepImpl = options.sleep ?? sleep;
  return {
    id: "codex",
    label: "Codex / ChatGPT",
    experimental: true,
    auth: {
      methods: [
        {
          type: "oauth",
          label: "ChatGPT/Codex browser code",
          prompts: [
            {
              type: "text",
              key: "redirectUri",
              message: "Local callback URL",
              placeholder: DEFAULT_REDIRECT_URI
            }
          ],
          authorize: async (inputs = {}) => {
            const redirectUri = inputs.redirectUri?.trim() || DEFAULT_REDIRECT_URI;
            const pkce = await generatePKCE(options.randomBytes);
            const state = generateRandomString(32, options.randomBytes);
            return {
              method: "code",
              url: buildCodexAuthorizeUrl(redirectUri, pkce, state),
              instructions: "Complete authorization in your browser, then paste the returned code.",
              callback: async (code: string, callbackOptions) => {
                const tokens = await exchangeCodeForCodexTokens(
                  fetchImpl,
                  code,
                  redirectUri,
                  pkce,
                  callbackOptions?.signal
                );
                return codexTokensToAuthRecord(tokens);
              }
            };
          }
        },
        {
          type: "oauth",
          label: "ChatGPT/Codex headless device",
          authorize: async () => {
            const device = await requestCodexDeviceCode(fetchImpl);
            return {
              method: "auto",
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${device.user_code}`,
              callback: (callbackOptions) => pollCodexDeviceToken({
                fetchImpl,
                sleepImpl,
                deviceAuthId: device.device_auth_id,
                userCode: device.user_code,
                intervalMs: device.intervalMs,
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
          baseURL: CODEX_API_ENDPOINT,
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
            originator: "alyce"
          }
        };
      }
    },
    models: async () => ({
      "gpt-5.1-codex": { label: "GPT-5.1 Codex" },
      "gpt-5.1-codex-mini": { label: "GPT-5.1 Codex Mini" },
      "gpt-5.2-codex": { label: "GPT-5.2 Codex" },
      "gpt-5.3-codex": { label: "GPT-5.3 Codex" }
    })
  };
}

export function buildCodexAuthorizeUrl(
  redirectUri: string,
  pkce: PkceCodes,
  state: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "alyce"
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

export async function refreshCodexAuth(
  auth: OAuthAuthRecord,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderAuthRecordInput> {
  if (!auth.refreshToken) {
    throw new Error("Codex refresh token is missing; reconnect Codex.");
  }

  const tokens = await refreshCodexAccessToken(fetchImpl, auth.refreshToken);
  return codexTokensToAuthRecord(tokens, auth.accountId);
}

export function rewriteCodexRequest(input: CodexRequestInput): CodexRequestInput {
  const url = input instanceof URL
    ? input
    : typeof input === "string"
      ? new URL(input)
      : new URL(input.url);
  if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) {
    return CODEX_API_ENDPOINT;
  }

  return input;
}

async function exchangeCodeForCodexTokens(
  fetchImpl: typeof fetch,
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
  abortSignal?: AbortSignal
): Promise<CodexTokenResponse> {
  throwIfAuthCancelled(abortSignal);
  const response = await fetchImpl(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier
    }).toString(),
    signal: abortSignal
  });
  if (!response.ok) {
    throw new Error(`Codex token exchange failed: HTTP ${response.status}`);
  }

  return response.json() as Promise<CodexTokenResponse>;
}

async function refreshCodexAccessToken(
  fetchImpl: typeof fetch,
  refreshToken: string
): Promise<CodexTokenResponse> {
  const response = await fetchImpl(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    }).toString()
  });
  if (!response.ok) {
    throw new Error(`Codex token refresh failed: HTTP ${response.status}`);
  }

  return response.json() as Promise<CodexTokenResponse>;
}

async function requestCodexDeviceCode(fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "alyce/codex-experimental"
    },
    body: JSON.stringify({ client_id: CLIENT_ID })
  });
  if (!response.ok) {
    throw new Error(`Codex device authorization failed: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string;
  };
  if (!data.device_auth_id || !data.user_code) {
    throw new Error("Codex device authorization response was missing required fields.");
  }

  return {
    device_auth_id: data.device_auth_id,
    user_code: data.user_code,
    intervalMs: Math.max(Number.parseInt(data.interval ?? "5", 10) || 5, 1) * 1000
  };
}

async function pollCodexDeviceToken(options: {
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  maxPolls?: number;
  pollingSafetyMarginMs?: number;
  abortSignal?: AbortSignal;
}): Promise<ProviderAuthRecordInput> {
  let attempts = 0;
  while (options.maxPolls === undefined || attempts < options.maxPolls) {
    throwIfAuthCancelled(options.abortSignal);
    attempts += 1;
    const response = await options.fetchImpl(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "alyce/codex-experimental"
      },
      body: JSON.stringify({
        device_auth_id: options.deviceAuthId,
        user_code: options.userCode
      }),
      signal: options.abortSignal
    });

    if (response.ok) {
      const deviceToken = await response.json() as {
        authorization_code: string;
        code_verifier: string;
      };
      const tokens = await exchangeDeviceAuthorizationForCodexTokens(
        options.fetchImpl,
        deviceToken,
        options.abortSignal
      );
      return codexTokensToAuthRecord(tokens);
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Codex device authorization failed: HTTP ${response.status}`);
    }

    await sleepWithAbort(
      options.sleepImpl,
      options.intervalMs + (options.pollingSafetyMarginMs ?? POLLING_SAFETY_MARGIN_MS),
      options.abortSignal
    );
  }

  throw new Error("Codex device authorization polling timed out.");
}

async function exchangeDeviceAuthorizationForCodexTokens(
  fetchImpl: typeof fetch,
  deviceToken: { authorization_code: string; code_verifier: string },
  abortSignal?: AbortSignal
): Promise<CodexTokenResponse> {
  throwIfAuthCancelled(abortSignal);
  const response = await fetchImpl(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: deviceToken.authorization_code,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: deviceToken.code_verifier
    }).toString(),
    signal: abortSignal
  });
  if (!response.ok) {
    throw new Error(`Codex token exchange failed: HTTP ${response.status}`);
  }

  return response.json() as Promise<CodexTokenResponse>;
}

function codexTokensToAuthRecord(
  tokens: CodexTokenResponse,
  fallbackAccountId?: string
): ProviderAuthRecordInput {
  return {
    type: "oauth",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(extractAccountId(tokens) ?? fallbackAccountId
      ? { accountId: extractAccountId(tokens) ?? fallbackAccountId }
      : {})
  };
}

export async function generatePKCE(
  randomBytes: ((length: number) => Uint8Array) | undefined = defaultRandomBytes
): Promise<PkceCodes> {
  const verifier = generateRandomString(43, randomBytes);
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return {
    verifier,
    challenge: base64UrlEncode(hash)
  };
}

export function extractAccountId(tokens: Pick<CodexTokenResponse, "id_token" | "access_token">): string | undefined {
  const idClaims = tokens.id_token ? parseJwtClaims(tokens.id_token) : undefined;
  const accessClaims = tokens.access_token ? parseJwtClaims(tokens.access_token) : undefined;
  return extractAccountIdFromClaims(idClaims) ?? extractAccountIdFromClaims(accessClaims);
}

function extractAccountIdFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) {
    return undefined;
  }

  const scoped = claims["https://api.openai.com/auth"];
  return asString(claims.chatgpt_account_id) ??
    (scoped && typeof scoped === "object"
      ? asString((scoped as Record<string, unknown>).chatgpt_account_id)
      : undefined) ??
    firstOrganizationId(claims.organizations);
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function firstOrganizationId(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const first = value[0];
  return first && typeof first === "object"
    ? asString((first as Record<string, unknown>).id)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function generateRandomString(
  length: number,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes
): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
