import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AuthStore, getAuthStorePath } from "../auth/authStore.js";
import { ProviderAuthService } from "./providerAuth.js";
import { loadConnectorPlugins } from "./pluginConnectors.js";

async function runTests() {
  await testUserPluginLoadsDeclarativeConnector();
  await testMissingProjectPluginDirectoryDoesNotEmitSkipDiagnostic();
  await testProjectPluginsAreSkippedByDefault();
  await testInvalidPluginReportsDiagnosticWithoutBlockingValidPlugins();
  console.log("plugin connector tests passed");
}

async function testUserPluginLoadsDeclarativeConnector() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-plugin-user-"));
  const userPlugins = path.join(home, "plugins");
  await writeManifest(path.join(userPlugins, "acme"), {
    version: 1,
    id: "acme",
    label: "Acme AI",
    provider: {
      kind: "openai-compatible",
      baseURL: "https://api.acme.example/v1",
      apiKeyEnv: "ACME_API_KEY",
      defaultModel: "acme-large",
      models: {
        "acme-large": { label: "Acme Large", contextWindow: 64000 }
      }
    },
    auth: {
      methods: [{
        type: "api",
        label: "API key",
        prompts: [{
          type: "text",
          key: "apiKey",
          message: "API key",
          secret: true
        }]
      }]
    }
  });

  const result = await loadConnectorPlugins({
    userPluginsDirectory: userPlugins
  });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.connectors[0]?.id, "acme");
  assert.equal(result.providerProfiles.acme?.baseURL, "https://api.acme.example/v1");
  assert.equal(result.providerProfiles.acme?.models?.["acme-large"]?.contextWindow, 64000);

  const authStore = await AuthStore.load(getAuthStorePath(path.join(home, ".alyce")));
  const service = new ProviderAuthService(result.connectors, authStore);
  const stored = await service.authorize("acme", 0, { apiKey: "acme-key" });

  assert.equal(stored.type, "stored");
  assert.equal(authStore.get("acme")?.type, "api");

  const runtimeOptions = await result.connectors[0]?.auth?.loader?.({
    getAuth: async () => authStore.get("acme"),
    provider: {
      id: "acme",
      label: "Acme AI",
      kind: "openai-compatible",
      baseURL: "https://api.acme.example/v1"
    }
  });
  assert.equal(runtimeOptions?.apiKey, "acme-key");
  assert.equal(runtimeOptions?.baseURL, "https://api.acme.example/v1");
}

async function testProjectPluginsAreSkippedByDefault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-plugin-project-"));
  const projectPlugins = path.join(root, ".alyce", "plugins");
  await writeManifest(path.join(projectPlugins, "project-provider"), {
    version: 1,
    id: "project-provider",
    provider: {
      baseURL: "https://project.example/v1",
      defaultModel: "project-model"
    }
  });

  const skipped = await loadConnectorPlugins({
    userPluginsDirectory: path.join(root, "user-plugins"),
    projectPluginsDirectory: projectPlugins
  });
  assert.equal(skipped.connectors.length, 0);
  assert.match(skipped.diagnostics[0]?.message ?? "", /disabled by default/);
  assert.equal(skipped.diagnostics[0]?.pluginPath, projectPlugins);

  const enabled = await loadConnectorPlugins({
    userPluginsDirectory: path.join(root, "user-plugins"),
    projectPluginsDirectory: projectPlugins,
    enableProjectPlugins: true
  });
  assert.equal(enabled.connectors[0]?.id, "project-provider");
}

async function testMissingProjectPluginDirectoryDoesNotEmitSkipDiagnostic() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-plugin-project-missing-"));
  const result = await loadConnectorPlugins({
    userPluginsDirectory: path.join(root, "user-plugins"),
    projectPluginsDirectory: path.join(root, ".alyce", "plugins")
  });

  assert.equal(result.connectors.length, 0);
  assert.equal(result.diagnostics.length, 0);
}

async function testInvalidPluginReportsDiagnosticWithoutBlockingValidPlugins() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-plugin-invalid-"));
  const userPlugins = path.join(home, "plugins");
  await writeManifest(path.join(userPlugins, "valid"), {
    version: 1,
    id: "valid",
    provider: {
      baseURL: "https://valid.example/v1",
      defaultModel: "valid-model"
    }
  });
  await fs.mkdir(path.join(userPlugins, "invalid"), { recursive: true });
  await fs.writeFile(
    path.join(userPlugins, "invalid", ".alyce-plugin.json"),
    JSON.stringify({ version: 1, label: "Missing id" }),
    "utf8"
  );

  const result = await loadConnectorPlugins({
    userPluginsDirectory: userPlugins
  });

  assert.equal(result.connectors.map((connector) => connector.id).join(","), "valid");
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.severity, "warning");
}

async function writeManifest(directory: string, manifest: unknown) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, ".alyce-plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
