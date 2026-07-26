import {
  buildProviderRegistry,
  mergeProviderProfileMaps,
  normalizeProviderProfileInputMap,
  type ProviderProfileInputMap
} from "../../core/providers/registry.js";
import type {
  ConnectionConfig,
  ConnectionConfigLayer,
  ConnectionConfigSaveTarget,
  ConnectionConfigSource,
  ConnectionConfigState,
  RuntimePaths
} from "./types.js";
import {
  buildSourceMap,
  compactObject,
  getArgValue,
  mergeLayers,
  normalizeOptionalText,
  type SourceLayer
} from "./shared.js";
import { writeJsonConfig } from "./configFiles.js";

export function buildConnectionConfigState(
  paths: Pick<RuntimePaths, "connectionConfigPath" | "userConnectionConfigPath">,
  layers: {
    user?: ConnectionConfigLayer;
    project?: ConnectionConfigLayer;
    env?: Partial<ConnectionConfig>;
    cli?: Partial<ConnectionConfig>;
    pluginProviders?: ProviderProfileInputMap;
    preferredSaveTarget?: ConnectionConfigSaveTarget;
  }
): ConnectionConfigState {
  const user = normalizeConnectionConfigLayer(layers.user);
  const project = normalizeConnectionConfigLayer(layers.project);
  const env = compactObject(layers.env ?? {});
  const cli = compactObject(layers.cli ?? {});
  // OPENAI_* values are startup defaults; saved connection config must override them.
  const orderedLayers: Array<SourceLayer<ConnectionConfig, ConnectionConfigSource>> = [
    { source: "env", values: env },
    { source: "project", values: stripProviderProfiles(project) },
    { source: "user", values: stripProviderProfiles(user) },
    { source: "cli", values: cli }
  ];
  const effective = normalizeConnectionConfig(mergeLayers(orderedLayers));
  const saveTarget = resolveConnectionSaveTarget({
    preferred: layers.preferredSaveTarget,
    user,
    project
  });

  return {
    effective,
    user,
    project,
    env,
    cli,
    sources: buildSourceMap(effective, orderedLayers, "default"),
    providerProfiles: buildProviderRegistry({
      connection: effective,
      configuredProviders: mergeProviderProfileMaps(
        layers.pluginProviders,
        project.providers,
        user.providers
      )
    }).providers,
    saveTarget,
    saveTargetPath:
      saveTarget === "project" ? paths.connectionConfigPath : paths.userConnectionConfigPath,
    userPath: paths.userConnectionConfigPath,
    projectPath: paths.connectionConfigPath
  };
}

export async function saveConnectionConfig(
  paths: RuntimePaths,
  target: ConnectionConfigSaveTarget,
  connection: ConnectionConfigLayer
): Promise<void> {
  await writeJsonConfig(
    target === "project" ? paths.connectionConfigPath : paths.userConnectionConfigPath,
    serializeConnectionConfig(connection)
  );
}

function normalizeConnectionConfig(input: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    apiKey: input.apiKey?.trim() ?? "",
    baseURL: normalizeOptionalText(input.baseURL),
    model: input.model?.trim() || "gpt-4.1-mini"
  };
}

function normalizeConnectionConfigLayer(
  input: ConnectionConfigLayer | undefined
): ConnectionConfigLayer {
  if (!input) {
    return {};
  }

  const providers = normalizeProviderProfileInputMap(input.providers);
  return compactObject({
    apiKey: "apiKey" in input ? input.apiKey?.trim() ?? "" : undefined,
    baseURL: "baseURL" in input ? normalizeOptionalText(input.baseURL) : undefined,
    model: "model" in input ? normalizeOptionalText(input.model) : undefined,
    providers:
      "providers" in input && Object.keys(providers).length > 0
        ? providers
        : undefined
  });
}

function stripProviderProfiles(input: ConnectionConfigLayer): Partial<ConnectionConfig> {
  const { providers: _providers, ...connection } = input;
  return connection;
}

function serializeConnectionConfig(connection: ConnectionConfigLayer): ConnectionConfigLayer {
  const providers = normalizeProviderProfileInputMap(connection.providers);
  return compactObject({
    apiKey: "apiKey" in connection ? connection.apiKey?.trim() ?? "" : undefined,
    baseURL:
      "baseURL" in connection
        ? connection.baseURL === undefined
          ? ""
          : connection.baseURL.trim()
        : undefined,
    model: "model" in connection ? normalizeOptionalText(connection.model) : undefined,
    providers:
      "providers" in connection && Object.keys(providers).length > 0
        ? providers
        : undefined
  });
}

export function resolveConnectionFromEnv(env: NodeJS.ProcessEnv): Partial<ConnectionConfig> {
  return compactObject({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL
  });
}

export function resolveConnectionFromCli(argv: string[]): Partial<ConnectionConfig> {
  return compactObject({
    model: getArgValue(argv, "--model")
  });
}

function resolveConnectionSaveTarget(options: {
  preferred?: ConnectionConfigSaveTarget;
  user: ConnectionConfigLayer;
  project: ConnectionConfigLayer;
}): ConnectionConfigSaveTarget {
  if (options.preferred) {
    return options.preferred;
  }

  // 连接配置通常包含敏感信息，默认优先写入 user 层，避免把密钥写回仓库目录。
  if (Object.keys(options.user).length > 0) {
    return "user";
  }

  return "project";
}
