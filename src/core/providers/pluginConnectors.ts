import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProviderProfileInputMap } from "./registry.js";
import { normalizeProviderProfileInputMap } from "./registry.js";
import type { AuthMethod, AuthPrompt, ProviderConnector } from "./providerAuth.js";
import type { ModelProfile, ProviderKind, ProviderProfile } from "./types.js";
import type { ProviderAuthRecord } from "../auth/authStore.js";

export type ConnectorPluginSource = "user" | "project";

export interface ConnectorPluginDiagnostic {
  severity: "info" | "warning";
  source: ConnectorPluginSource;
  pluginPath: string;
  message: string;
}

export interface ConnectorPluginLoadResult {
  connectors: ProviderConnector[];
  providerProfiles: ProviderProfileInputMap;
  diagnostics: ConnectorPluginDiagnostic[];
}

export interface ConnectorPluginLoadOptions {
  userPluginsDirectory: string;
  projectPluginsDirectory?: string;
  enableProjectPlugins?: boolean;
}

const PROVIDER_KINDS: ProviderKind[] = [
  "openai-compatible",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "local"
];

const AuthPromptConditionSchema = z
  .object({
    key: z.string().min(1),
    op: z.enum(["eq", "neq"]),
    value: z.string()
  })
  .strict();

const AuthPromptSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      key: z.string().min(1),
      message: z.string().min(1),
      placeholder: z.string().optional(),
      secret: z.boolean().optional(),
      when: AuthPromptConditionSchema.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      key: z.string().min(1),
      message: z.string().min(1),
      options: z.array(z.object({
        label: z.string().min(1),
        value: z.string(),
        hint: z.string().optional()
      }).strict()).min(1),
      when: AuthPromptConditionSchema.optional()
    })
    .strict()
]);

const ManifestAuthMethodSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("api"),
      label: z.string().min(1),
      prompts: z.array(AuthPromptSchema).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("wellknown"),
      label: z.string().min(1),
      prompts: z.array(AuthPromptSchema).optional()
    })
    .strict()
]);

const ModelProfileSchema = z
  .object({
    label: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    inputCostPerMillionTokens: z.number().nonnegative().optional(),
    outputCostPerMillionTokens: z.number().nonnegative().optional()
  })
  .strict();

const ConnectorPluginManifestSchema = z
  .object({
    version: z.literal(1).optional(),
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    experimental: z.boolean().optional(),
    disabled: z.boolean().optional(),
    provider: z
      .object({
        id: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
        kind: z.enum(PROVIDER_KINDS as [ProviderKind, ...ProviderKind[]]).optional(),
        apiKeyEnv: z.string().optional(),
        baseURL: z.string().optional(),
        defaultModel: z.string().optional(),
        models: z.record(ModelProfileSchema).optional()
      })
      .strict()
      .optional(),
    auth: z
      .object({
        methods: z.array(ManifestAuthMethodSchema).optional()
      })
      .strict()
      .optional()
  })
  .strict();

type ConnectorPluginManifest = z.infer<typeof ConnectorPluginManifestSchema>;

const MANIFEST_FILENAMES = [".alyce-plugin.json", "connector.json"];

export async function loadConnectorPlugins(
  options: ConnectorPluginLoadOptions
): Promise<ConnectorPluginLoadResult> {
  const diagnostics: ConnectorPluginDiagnostic[] = [];
  const loaded: Array<{
    manifest: ConnectorPluginManifest;
    manifestPath: string;
    source: ConnectorPluginSource;
  }> = [];

  loaded.push(...await loadPluginDirectory(
    options.userPluginsDirectory,
    "user",
    true,
    diagnostics
  ));

  if (options.projectPluginsDirectory) {
    loaded.push(...await loadPluginDirectory(
      options.projectPluginsDirectory,
      "project",
      options.enableProjectPlugins === true,
      diagnostics
    ));
  }

  const connectors: ProviderConnector[] = [];
  const rawProviderProfiles: ProviderProfileInputMap = {};
  for (const entry of loaded) {
    if (entry.manifest.disabled) {
      diagnostics.push({
        severity: "info",
        source: entry.source,
        pluginPath: entry.manifestPath,
        message: "Plugin is disabled by manifest."
      });
      continue;
    }

    connectors.push(createConnectorFromManifest(entry.manifest));
    const providerProfile = createProviderProfileFromManifest(entry.manifest);
    rawProviderProfiles[entry.manifest.id.trim().toLowerCase()] = providerProfile;
  }

  return {
    connectors,
    providerProfiles: normalizeProviderProfileInputMap(rawProviderProfiles),
    diagnostics
  };
}

async function loadPluginDirectory(
  root: string,
  source: ConnectorPluginSource,
  enabled: boolean,
  diagnostics: ConnectorPluginDiagnostic[]
) {
  const entries = await readDirectoryEntries(root, source, diagnostics);
  if (!entries) {
    return [];
  }

  const loaded: Array<{
    manifest: ConnectorPluginManifest;
    manifestPath: string;
    source: ConnectorPluginSource;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginPath = path.join(root, entry.name);
    if (!enabled) {
      diagnostics.push({
        severity: "info",
        source,
        pluginPath,
        message: "Project connector plugins are disabled by default."
      });
      continue;
    }

    const manifestPath = await findManifestPath(pluginPath);
    if (!manifestPath) {
      diagnostics.push({
        severity: "warning",
        source,
        pluginPath,
        message: `Missing plugin manifest (${MANIFEST_FILENAMES.join(" or ")}).`
      });
      continue;
    }

    try {
      loaded.push({
        manifest: await readManifest(manifestPath),
        manifestPath,
        source
      });
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        source,
        pluginPath: manifestPath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return loaded;
}

async function readDirectoryEntries(
  root: string,
  source: ConnectorPluginSource,
  diagnostics: ConnectorPluginDiagnostic[]
) {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    diagnostics.push({
      severity: "warning",
      source,
      pluginPath: root,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function findManifestPath(pluginPath: string): Promise<string | null> {
  for (const name of MANIFEST_FILENAMES) {
    const candidate = path.join(pluginPath, name);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function readManifest(manifestPath: string): Promise<ConnectorPluginManifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return ConnectorPluginManifestSchema.parse(parsed);
}

function createConnectorFromManifest(manifest: ConnectorPluginManifest): ProviderConnector {
  const providerId = manifest.id.trim().toLowerCase();
  const models = manifest.provider?.models as Record<string, ModelProfile> | undefined;
  const methods = (manifest.auth?.methods ?? []).map(createAuthMethodFromManifest);
  return {
    id: providerId,
    label: manifest.label?.trim() || manifest.provider?.label?.trim() || providerId,
    ...(manifest.experimental !== undefined ? { experimental: manifest.experimental } : {}),
    ...(methods.length > 0
      ? {
          auth: {
            methods,
            loader: async ({ getAuth, provider }) => createDeclarativeRuntimeOptions(
              await getAuth(),
              provider
            )
          }
        }
      : {}),
    ...(models && Object.keys(models).length > 0
      ? { models: async () => ({ ...models }) }
      : {})
  };
}

function createDeclarativeRuntimeOptions(
  auth: ProviderAuthRecord | undefined,
  provider: ProviderProfile
) {
  if (!auth) {
    return {};
  }

  if (auth.type === "api") {
    return {
      apiKey: auth.apiKey,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {})
    };
  }

  if (auth.type === "oauth") {
    return {
      apiKey: auth.accessToken,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {})
    };
  }

  return {
    apiKey: auth.token,
    ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    headers: {
      "x-alyce-well-known-key": auth.key
    }
  };
}

function createProviderProfileFromManifest(
  manifest: ConnectorPluginManifest
): ProviderProfileInputMap[string] {
  const provider = manifest.provider ?? {};
  return {
    id: manifest.id.trim().toLowerCase(),
    label: provider.label?.trim() || manifest.label?.trim() || manifest.id.trim(),
    kind: provider.kind ?? "openai-compatible",
    ...(provider.apiKeyEnv?.trim() ? { apiKeyEnv: provider.apiKeyEnv.trim() } : {}),
    ...(provider.baseURL?.trim() ? { baseURL: provider.baseURL.trim() } : {}),
    ...(provider.defaultModel?.trim() ? { defaultModel: provider.defaultModel.trim() } : {}),
    ...(provider.models ? { models: provider.models } : {})
  };
}

function createAuthMethodFromManifest(
  method: z.infer<typeof ManifestAuthMethodSchema>
): AuthMethod {
  if (method.type === "api") {
    return {
      type: "api",
      label: method.label,
      prompts: method.prompts as AuthPrompt[] | undefined
    };
  }

  return {
    type: "wellknown",
    label: method.label,
    prompts: method.prompts as AuthPrompt[] | undefined,
    authorize: async (inputs) => {
      const key = inputs.key?.trim();
      const token = inputs.token?.trim();
      if (!key || !token) {
        throw new Error("Well-known plugin auth requires key and token inputs.");
      }

      return {
        type: "wellknown",
        key,
        token
      };
    }
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
