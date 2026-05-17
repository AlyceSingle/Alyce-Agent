import assert from "node:assert/strict";
import {
  buildCodexAuthorizeUrl,
  createCodexConnector,
  extractAccountId,
  generatePKCE,
  refreshCodexAuth,
  rewriteCodexRequest
} from "./codex.experimental.js";
import type { OAuthAuthRecord } from "../../auth/authStore.js";
import type { ProviderConnector } from "../providerAuth.js";

async function runTests() {
  await testBrowserCodeFlowBuildsPkceUrlAndStoresOAuth();
  await testHeadlessDeviceFlowPollsPendingThenStoresOAuth();
  await testRefreshCodexAuth();
  testRewriteCodexRequestOnlyTargetsCodexPaths();
  testExtractAccountIdFromJwtClaims();
  console.log("Codex connector tests passed");
}

async function testBrowserCodeFlowBuildsPkceUrlAndStoresOAuth() {
  const calls: FetchCall[] = [];
  const connector = createCodexConnector({
    fetch: createFetch(calls, [
      {
        status: 200,
        body: {
          access_token: fakeJwt({ chatgpt_account_id: "account-1" }),
          refresh_token: "refresh-token",
          expires_in: 60
        }
      }
    ]),
    randomBytes: zeroBytes
  });

  const flow = await firstAuthMethod(connector, 0).authorize({
    redirectUri: "http://localhost:1777/auth/callback"
  });
  if (flow.method !== "code") {
    throw new Error("Expected code flow.");
  }
  const auth = await flow.callback("browser-code");
  const url = new URL(flow.url);

  assert.equal(flow.method, "code");
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1777/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(auth.type, "oauth");
  assert.equal(auth.refreshToken, "refresh-token");
  assert.equal(auth.accountId, "account-1");
  assert.equal(calls[0]?.url, "https://auth.openai.com/oauth/token");
  assert.match(calls[0]?.body ?? "", /grant_type=authorization_code/);
  assert.match(calls[0]?.body ?? "", /code=browser-code/);
}

async function testHeadlessDeviceFlowPollsPendingThenStoresOAuth() {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  const connector = createCodexConnector({
    fetch: createFetch(calls, [
      {
        status: 200,
        body: {
          device_auth_id: "device-auth-id",
          user_code: "CODE-123",
          interval: "1"
        }
      },
      { status: 403, body: {} },
      { status: 404, body: {} },
      {
        status: 200,
        body: {
          authorization_code: "device-authorization-code",
          code_verifier: "device-code-verifier"
        }
      },
      {
        status: 200,
        body: {
          id_token: fakeJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "account-from-id-token"
            }
          }),
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 120
        }
      }
    ]),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    pollingSafetyMarginMs: 0,
    maxPolls: 4
  });

  const flow = await firstAuthMethod(connector, 1).authorize({});
  if (flow.method !== "auto") {
    throw new Error("Expected auto flow.");
  }
  const auth = await flow.callback();

  assert.equal(flow.method, "auto");
  assert.match(flow.instructions, /CODE-123/);
  assert.equal(auth.type, "oauth");
  assert.equal(auth.accessToken, "access-token");
  assert.equal(auth.accountId, "account-from-id-token");
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(calls[0]?.url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.equal(calls[1]?.url, "https://auth.openai.com/api/accounts/deviceauth/token");
  assert.equal(calls[4]?.url, "https://auth.openai.com/oauth/token");
  assert.match(calls[4]?.body ?? "", /code=device-authorization-code/);
}

async function testRefreshCodexAuth() {
  const refreshed = await refreshCodexAuth({
    type: "oauth",
    accessToken: "old-access",
    refreshToken: "refresh-token",
    accountId: "existing-account",
    updatedAt: new Date(0).toISOString()
  }, createFetch([], [
    {
      status: 200,
      body: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 30
      }
    }
  ]));

  assert.equal(refreshed.type, "oauth");
  assert.equal(refreshed.accessToken, "new-access");
  assert.equal(refreshed.refreshToken, "new-refresh");
  assert.equal(refreshed.accountId, "existing-account");

  await assert.rejects(
    () => refreshCodexAuth({
      type: "oauth",
      accessToken: "old-access",
      updatedAt: new Date(0).toISOString()
    } as OAuthAuthRecord, createFetch([], [])),
    /refresh token is missing/
  );
}

function testRewriteCodexRequestOnlyTargetsCodexPaths() {
  assert.equal(
    rewriteCodexRequest("https://api.openai.com/v1/responses"),
    "https://chatgpt.com/backend-api/codex/responses"
  );
  assert.equal(
    rewriteCodexRequest(new URL("https://api.openai.com/chat/completions")),
    "https://chatgpt.com/backend-api/codex/responses"
  );
  assert.equal(
    rewriteCodexRequest("https://api.openai.com/v1/models"),
    "https://api.openai.com/v1/models"
  );
  assert.equal(
    rewriteCodexRequest({ url: "https://api.openai.com/v1/responses" }),
    "https://chatgpt.com/backend-api/codex/responses"
  );
}

function testExtractAccountIdFromJwtClaims() {
  assert.equal(
    extractAccountId({
      id_token: fakeJwt({ organizations: [{ id: "org-1" }] }),
      access_token: "access"
    }),
    "org-1"
  );
  assert.equal(
    extractAccountId({
      id_token: "not-a-jwt",
      access_token: fakeJwt({ chatgpt_account_id: "account-2" })
    }),
    "account-2"
  );
}

async function testPkceUrlHelperCompiles() {
  const pkce = await generatePKCE(zeroBytes);
  assert.match(buildCodexAuthorizeUrl("http://localhost/callback", pkce, "state"), /code_challenge=/);
}

function firstAuthMethod(connector: ProviderConnector, index: number) {
  const method = connector.auth?.methods[index];
  assert.equal(method?.type, "oauth");
  if (!method || method.type !== "oauth") {
    throw new Error("Expected OAuth auth method.");
  }

  return method;
}

interface FetchCall {
  url: string;
  body?: string;
}

function createFetch(
  calls: FetchCall[],
  responses: Array<{ status: number; body: unknown }>
): typeof fetch {
  let index = 0;
  return (async (input: string | URL, init?: RequestInit) => {
    const response = responses[index++];
    if (!response) {
      throw new Error("Unexpected fetch call.");
    }

    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : undefined
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
}

function fakeJwt(claims: Record<string, unknown>): string {
  return [
    "header",
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature"
  ].join(".");
}

function zeroBytes(length: number): Uint8Array {
  return new Uint8Array(length);
}

void testPkceUrlHelperCompiles()
  .then(runTests)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
