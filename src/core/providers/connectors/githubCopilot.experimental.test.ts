import assert from "node:assert/strict";
import {
  createGitHubCopilotConnector,
  getGitHubDeviceUrls,
  normalizeDomain,
  parseGitHubCopilotModels
} from "./githubCopilot.experimental.js";
import type { ProviderConnector } from "../providerAuth.js";

async function runTests() {
  await testDeviceFlowPollsPendingSlowDownThenStoresOAuth();
  await testDeviceFlowFailureReportsProviderError();
  testEnterpriseDomainNormalization();
  testParseGitHubCopilotModels();
  console.log("GitHub Copilot connector tests passed");
}

async function testDeviceFlowPollsPendingSlowDownThenStoresOAuth() {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  const connector = createGitHubCopilotConnector({
    fetch: createFetch(calls, [
      {
        status: 200,
        body: {
          verification_uri: "https://github.com/login/device",
          user_code: "ABCD-1234",
          device_code: "device-code",
          interval: 1
        }
      },
      { status: 200, body: { error: "authorization_pending" } },
      { status: 200, body: { error: "slow_down", interval: 7 } },
      { status: 200, body: { access_token: "copilot-token" } }
    ]),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    pollingSafetyMarginMs: 0,
    maxPolls: 4
  });

  const flow = await firstAuthMethod(connector).authorize({
    deploymentType: "enterprise",
    enterpriseUrl: "https://ghe.example.com/"
  });
  if (flow.method !== "auto") {
    throw new Error("Expected auto flow.");
  }
  const auth = await flow.callback();

  assert.equal(flow.method, "auto");
  assert.equal(flow.url, "https://github.com/login/device");
  assert.match(flow.instructions, /ABCD-1234/);
  assert.equal(auth.type, "oauth");
  assert.equal(auth.accessToken, "copilot-token");
  assert.equal(auth.refreshToken, "copilot-token");
  assert.deepEqual(auth.extra, { enterpriseUrl: "ghe.example.com" });
  assert.deepEqual(sleeps, [1000, 7000]);
  assert.equal(calls[0]?.url, "https://ghe.example.com/login/device/code");
  assert.equal(calls[1]?.url, "https://ghe.example.com/login/oauth/access_token");
  assert.match(calls[0]?.body ?? "", /Ov23lifo23d1GEpDddQc/);
  assert.match(calls[1]?.body ?? "", /Ov23lifo23d1GEpDddQc/);
  assert.match(calls[1]?.body ?? "", /device-code/);
}

async function testDeviceFlowFailureReportsProviderError() {
  const connector = createGitHubCopilotConnector({
    fetch: createFetch([], [
      {
        status: 200,
        body: {
          verification_uri: "https://github.com/login/device",
          user_code: "ABCD-1234",
          device_code: "device-code",
          interval: 1
        }
      },
      { status: 200, body: { error: "expired_token" } }
    ]),
    sleep: async () => undefined,
    pollingSafetyMarginMs: 0,
    maxPolls: 2
  });

  const flow = await firstAuthMethod(connector).authorize({
    deploymentType: "github.com"
  });
  if (flow.method !== "auto") {
    throw new Error("Expected auto flow.");
  }

  await assert.rejects(
    () => flow.callback(),
    /GitHub device authorization failed: expired_token/
  );
}

function testEnterpriseDomainNormalization() {
  assert.equal(normalizeDomain(" https://ghe.example.com/ "), "ghe.example.com");
  assert.deepEqual(getGitHubDeviceUrls("ghe.example.com"), {
    deviceCodeUrl: "https://ghe.example.com/login/device/code",
    accessTokenUrl: "https://ghe.example.com/login/oauth/access_token"
  });
}

function testParseGitHubCopilotModels() {
  const models = parseGitHubCopilotModels({
    data: [
      {
        model_picker_enabled: true,
        id: "gpt-5.2",
        name: "GPT-5.2",
        capabilities: {
          limits: {
            max_context_window_tokens: 400_000,
            max_output_tokens: 16_384
          }
        }
      },
      {
        model_picker_enabled: false,
        id: "hidden-model",
        name: "Hidden",
        capabilities: { limits: {} }
      }
    ]
  });

  assert.deepEqual(models, {
    "gpt-5.2": {
      label: "GPT-5.2",
      contextWindow: 400_000,
      maxOutputTokens: 16_384
    }
  });
}

function firstAuthMethod(connector: ProviderConnector) {
  const method = connector.auth?.methods[0];
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

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
