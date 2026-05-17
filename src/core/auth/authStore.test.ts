import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  applyProviderAuthRecords,
  AuthStore,
  getAuthStorePath
} from "./authStore.js";
import type { ProviderProfileMap } from "../providers/types.js";

async function runTests() {
  await testAuthStoreSetGetRemove();
  await testAuthStoreStoresOAuthAndWellKnownRecords();
  await testMalformedAuthStoreReportsReadableError();
  testAppliesAuthRecordsWithoutMutatingProviderProfiles();
  testAppliesGitHubCopilotOAuthRuntimeOptions();
  console.log("authStore tests passed");
}

async function testAuthStoreSetGetRemove() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-auth-store-"));
  const authPath = getAuthStorePath(path.join(home, ".alyce"));
  const store = await AuthStore.load(authPath);

  assert.equal(store.get("openrouter"), undefined);
  await store.set("OpenRouter", {
    type: "api",
    apiKey: "  router-key  "
  });

  const apiAuth = store.get("openrouter");
  assert.equal(apiAuth?.type === "api" ? apiAuth.apiKey : "", "router-key");
  assert.equal(store.get("OPENROUTER")?.type, "api");

  const raw = JSON.parse(await fs.readFile(authPath, "utf8")) as {
    version?: number;
    providers?: Record<string, { apiKey?: string }>;
  };
  assert.equal(raw.version, 1);
  assert.equal(raw.providers?.openrouter?.apiKey, "router-key");

  assert.equal(await store.remove("openrouter"), true);
  assert.equal(store.get("openrouter"), undefined);
  assert.equal(await store.remove("openrouter"), false);
}

async function testAuthStoreStoresOAuthAndWellKnownRecords() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-auth-store-oauth-"));
  const authPath = getAuthStorePath(path.join(home, ".alyce"));
  const store = await AuthStore.load(authPath);

  await store.set("github-copilot", {
    type: "oauth",
    accessToken: " access-token ",
    refreshToken: " refresh-token ",
    expiresAt: 123,
    accountId: " user-1 ",
    extra: { enterpriseUrl: "https://github.com" }
  });
  await store.set("wellknown-demo", {
    type: "wellknown",
    key: " device-key ",
    token: " device-token "
  });

  const oauth = store.get("github-copilot");
  const wellknown = store.get("wellknown-demo");

  assert.equal(oauth?.type, "oauth");
  assert.equal(oauth?.type === "oauth" ? oauth.accessToken : "", "access-token");
  assert.equal(wellknown?.type, "wellknown");
  assert.equal(wellknown?.type === "wellknown" ? wellknown.token : "", "device-token");
}

async function testMalformedAuthStoreReportsReadableError() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-auth-store-bad-"));
  const authPath = getAuthStorePath(path.join(home, ".alyce"));
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  await fs.writeFile(
    authPath,
    JSON.stringify({
      version: 1,
      providers: {
        openrouter: {
          type: "api",
          apiKey: 123
        }
      }
    }),
    "utf8"
  );

  await assert.rejects(
    () => AuthStore.load(authPath),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("Invalid auth store") &&
      error.message.includes("providers.openrouter.apiKey")
  );
}

function testAppliesAuthRecordsWithoutMutatingProviderProfiles() {
  const providers: ProviderProfileMap = {
    openrouter: {
      id: "openrouter",
      label: "OpenRouter",
      kind: "openrouter",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseURL: "https://openrouter.ai/api/v1",
      defaultModel: "openai/gpt-5.2",
      models: {
        "openai/gpt-5.2": {
          contextWindow: 400_000
        }
      }
    }
  };

  const withAuth = applyProviderAuthRecords(providers, {
    openrouter: {
      type: "api",
      apiKey: "router-key",
      updatedAt: new Date(0).toISOString()
    }
  });

  assert.equal(withAuth.openrouter?.apiKey, "router-key");
  assert.equal(providers.openrouter?.apiKey, undefined);
  assert.deepEqual(withAuth.openrouter?.models, providers.openrouter?.models);
}

function testAppliesGitHubCopilotOAuthRuntimeOptions() {
  const providers: ProviderProfileMap = {
    "github-copilot": {
      id: "github-copilot",
      label: "GitHub Copilot",
      kind: "openai-compatible",
      baseURL: "https://api.githubcopilot.com",
      defaultModel: "gpt-5.2",
      models: {
        "gpt-5.2": {}
      }
    }
  };

  const withAuth = applyProviderAuthRecords(providers, {
    "github-copilot": {
      type: "oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      extra: { enterpriseUrl: "ghe.example.com" },
      updatedAt: new Date(0).toISOString()
    }
  });

  assert.equal(withAuth["github-copilot"]?.apiKey, "refresh-token");
  assert.equal(withAuth["github-copilot"]?.baseURL, "https://copilot-api.ghe.example.com");
  assert.equal(withAuth["github-copilot"]?.headers?.Authorization, "Bearer refresh-token");
  assert.equal(providers["github-copilot"]?.apiKey, undefined);
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
