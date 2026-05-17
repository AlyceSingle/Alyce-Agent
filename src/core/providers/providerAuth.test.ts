import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AuthStore, getAuthStorePath } from "../auth/authStore.js";
import {
  ProviderAuthService,
  type ProviderConnector
} from "./providerAuth.js";

async function runTests() {
  await testApiAuthMethodStoresImmediately();
  await testOAuthCodeFlowStoresOnCallback();
  await testOAuthCallbackNormalizesProviderId();
  await testClearedPendingFlowDoesNotStoreLateCallbackResult();
  await testAbortedPendingFlowIsCleared();
  await testMissingPendingFlowReportsReadableError();
  console.log("providerAuth tests passed");
}

async function testApiAuthMethodStoresImmediately() {
  const service = await createService([{
    id: "demo",
    label: "Demo",
    auth: {
      methods: [{
        type: "api",
        label: "API key"
      }]
    }
  }]);

  const result = await service.authorize("demo", 0, {
    apiKey: "demo-key"
  });

  assert.equal(result.type, "stored");
  assert.equal(result.type === "stored" ? result.auth.type : "", "api");
  assert.equal(result.type === "stored" && result.auth.type === "api" ? result.auth.apiKey : "", "demo-key");
}

async function testOAuthCodeFlowStoresOnCallback() {
  const service = await createService([{
    id: "oauth-demo",
    label: "OAuth Demo",
    auth: {
      methods: [{
        type: "oauth",
        label: "Browser code",
        authorize: async () => ({
          method: "code",
          url: "https://example.com/auth",
          instructions: "Paste code",
          callback: async (code: string) => ({
            type: "oauth",
            accessToken: `access-${code}`,
            refreshToken: "refresh-token",
            expiresAt: 123
          })
        })
      }]
    }
  }]);

  const started = await service.authorize("oauth-demo", 0);
  assert.equal(started.type, "flow");
  assert.equal(started.type === "flow" ? started.flow.method : "", "code");

  const stored = await service.callback("oauth-demo", 0, "abc");
  assert.equal(stored.type, "oauth");
  assert.equal(stored.type === "oauth" ? stored.accessToken : "", "access-abc");
}

async function testOAuthCallbackNormalizesProviderId() {
  const service = await createService([{
    id: "oauth-demo",
    label: "OAuth Demo",
    auth: {
      methods: [{
        type: "oauth",
        label: "Browser code",
        authorize: async () => ({
          method: "code",
          url: "https://example.com/auth",
          instructions: "Paste code",
          callback: async (code: string) => ({
            type: "oauth",
            accessToken: `access-${code}`
          })
        })
      }]
    }
  }]);

  await service.authorize("OAuth-Demo", 0);
  const pending = service.getPendingFlow("OAUTH-DEMO", 0);
  const stored = await service.callback("OAUTH-DEMO", 0, "case");

  assert.equal(pending?.method, "code");
  assert.equal(stored.type === "oauth" ? stored.accessToken : "", "access-case");
}

async function testMissingPendingFlowReportsReadableError() {
  const service = await createService([]);

  await assert.rejects(
    () => service.callback("missing", 0, "code"),
    /No pending auth flow/
  );
}

async function testClearedPendingFlowDoesNotStoreLateCallbackResult() {
  let resolveCallback: ((auth: { type: "oauth"; accessToken: string }) => void) | undefined;
  const service = await createService([{
    id: "oauth-cancel",
    label: "OAuth Cancel",
    auth: {
      methods: [{
        type: "oauth",
        label: "Browser code",
        authorize: async () => ({
          method: "auto",
          url: "https://example.com/auth",
          instructions: "Wait",
          callback: async () => new Promise((resolve) => {
            resolveCallback = resolve;
          })
        })
      }]
    }
  }]);

  await service.authorize("oauth-cancel", 0);
  const pending = service.callback("oauth-cancel", 0);
  service.clearPending("oauth-cancel");
  resolveCallback?.({ type: "oauth", accessToken: "late-token" });

  await assert.rejects(pending, /cancelled/);
}

async function testAbortedPendingFlowIsCleared() {
  const service = await createService([{
    id: "oauth-abort",
    label: "OAuth Abort",
    auth: {
      methods: [{
        type: "oauth",
        label: "Browser code",
        authorize: async () => ({
          method: "auto",
          url: "https://example.com/auth",
          instructions: "Wait",
          callback: async () => {
            throw new Error("should not run");
          }
        })
      }]
    }
  }]);
  const controller = new AbortController();

  await service.authorize("oauth-abort", 0);
  controller.abort();

  await assert.rejects(
    () => service.callback("oauth-abort", 0, undefined, { signal: controller.signal }),
    /cancelled/
  );
  await assert.rejects(
    () => service.callback("oauth-abort", 0),
    /No pending auth flow/
  );
}

async function createService(connectors: ProviderConnector[]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-provider-auth-"));
  const authPath = getAuthStorePath(path.join(home, ".alyce"));
  const authStore = await AuthStore.load(authPath);
  return new ProviderAuthService(connectors, authStore);
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
