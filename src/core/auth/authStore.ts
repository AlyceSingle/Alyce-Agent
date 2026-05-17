import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProviderProfileMap } from "../providers/types.js";

export interface ApiAuthRecord {
  type: "api";
  apiKey: string;
  updatedAt: string;
}

export interface OAuthAuthRecord {
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  extra?: Record<string, unknown>;
  updatedAt: string;
}

export interface WellKnownAuthRecord {
  type: "wellknown";
  key: string;
  token: string;
  updatedAt: string;
}

export type ProviderAuthRecord = ApiAuthRecord | OAuthAuthRecord | WellKnownAuthRecord;
export type ProviderAuthRecordInput =
  | Omit<ApiAuthRecord, "updatedAt">
  | Omit<OAuthAuthRecord, "updatedAt">
  | Omit<WellKnownAuthRecord, "updatedAt">;
export type ProviderAuthMap = Record<string, ProviderAuthRecord>;

const ApiAuthRecordSchema = z
  .object({
    type: z.literal("api"),
    apiKey: z.string(),
    updatedAt: z.string().optional()
  })
  .strict();

const OAuthAuthRecordSchema = z
  .object({
    type: z.literal("oauth"),
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    accountId: z.string().optional(),
    extra: z.record(z.unknown()).optional(),
    updatedAt: z.string().optional()
  })
  .strict();

const WellKnownAuthRecordSchema = z
  .object({
    type: z.literal("wellknown"),
    key: z.string(),
    token: z.string(),
    updatedAt: z.string().optional()
  })
  .strict();

const ProviderAuthRecordSchema = z.discriminatedUnion("type", [
  ApiAuthRecordSchema,
  OAuthAuthRecordSchema,
  WellKnownAuthRecordSchema
]);

const AuthStoreFileSchema = z
  .object({
    version: z.literal(1).optional(),
    providers: z.record(ProviderAuthRecordSchema).optional()
  })
  .strict();

interface AuthStoreFile {
  version?: 1;
  providers?: Record<string, z.infer<typeof ProviderAuthRecordSchema>>;
}

export function getAuthStorePath(userAlyceDirectory: string): string {
  return path.join(userAlyceDirectory, "auth.json");
}

export class AuthStore {
  private records: ProviderAuthMap;

  private constructor(
    private readonly filePath: string,
    records: ProviderAuthMap
  ) {
    this.records = records;
  }

  static async load(filePath: string): Promise<AuthStore> {
    return new AuthStore(filePath, await readAuthStoreFile(filePath));
  }

  getPath(): string {
    return this.filePath;
  }

  get(providerId: string): ProviderAuthRecord | undefined {
    const record = this.records[normalizeProviderId(providerId)];
    return record ? { ...record } : undefined;
  }

  all(): ProviderAuthMap {
    return cloneAuthMap(this.records);
  }

  async set(providerId: string, record: ProviderAuthRecordInput): Promise<void> {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) {
      throw new Error("Provider id is required.");
    }

    this.records = {
      ...this.records,
      [normalizedProviderId]: normalizeAuthRecordInput(record)
    };
    await this.save();
  }

  async remove(providerId: string): Promise<boolean> {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId || !this.records[normalizedProviderId]) {
      return false;
    }

    const next = { ...this.records };
    delete next[normalizedProviderId];
    this.records = next;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await writeAuthStoreFile(this.filePath, this.records);
  }
}

export function applyProviderAuthRecords(
  providers: ProviderProfileMap,
  authRecords: ProviderAuthMap
): ProviderProfileMap {
  const cloned: ProviderProfileMap = {};
  for (const [providerId, provider] of Object.entries(providers)) {
    const auth = authRecords[normalizeProviderId(providerId)];
    const oauthRuntime = auth?.type === "oauth"
      ? createOAuthProviderRuntime(providerId, auth)
      : {};
    cloned[providerId] = {
      ...provider,
      models: provider.models ? { ...provider.models } : undefined,
      ...(provider.headers ? { headers: { ...provider.headers } } : {}),
      ...(auth?.type === "api" && auth.apiKey.trim() ? { apiKey: auth.apiKey.trim() } : {}),
      ...oauthRuntime
    };
  }

  return cloned;
}

function createOAuthProviderRuntime(
  providerId: string,
  auth: Extract<ProviderAuthRecord, { type: "oauth" }>
): Pick<ProviderProfileMap[string], "apiKey" | "baseURL" | "headers"> {
  const token = auth.refreshToken?.trim() || auth.accessToken.trim();
  if (!token) {
    return {};
  }

  if (normalizeProviderId(providerId) === "github-copilot") {
    const enterpriseUrl = typeof auth.extra?.enterpriseUrl === "string"
      ? auth.extra.enterpriseUrl.trim()
      : "";
    return {
      apiKey: token,
      baseURL: enterpriseUrl
        ? `https://copilot-api.${enterpriseUrl}`
        : "https://api.githubcopilot.com",
      headers: {
        Authorization: `Bearer ${token}`,
        "Openai-Intent": "conversation-edits",
        "x-initiator": "user",
        "User-Agent": "alyce/github-copilot"
      }
    };
  }

  return {
    apiKey: token
  };
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase();
}

async function readAuthStoreFile(filePath: string): Promise<ProviderAuthMap> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = AuthStoreFileSchema.parse(JSON.parse(raw) as unknown) as AuthStoreFile;
    return normalizeAuthMap(parsed.providers ?? {});
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid auth store ${filePath}: ${details}`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read auth store ${filePath}: ${message}`);
  }
}

async function writeAuthStoreFile(filePath: string, records: ProviderAuthMap): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      providers: records
    }, null, 2) + "\n",
    "utf8"
  );
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

function normalizeAuthMap(input: Record<string, z.infer<typeof ProviderAuthRecordSchema>>): ProviderAuthMap {
  const normalized: ProviderAuthMap = {};
  for (const [providerId, record] of Object.entries(input)) {
    const id = normalizeProviderId(providerId);
    if (!id) {
      continue;
    }

    try {
      normalized[id] = normalizeAuthRecordInput(record);
    } catch {
      continue;
    }
  }

  return normalized;
}

function normalizeAuthRecordInput(record: ProviderAuthRecordInput | z.infer<typeof ProviderAuthRecordSchema>): ProviderAuthRecord {
  const updatedAt = "updatedAt" in record && typeof record.updatedAt === "string" && record.updatedAt.trim()
    ? record.updatedAt.trim()
    : new Date().toISOString();

  if (record.type === "api") {
    const apiKey = record.apiKey.trim();
    if (!apiKey) {
      throw new Error("API key is required.");
    }

    return {
      type: "api",
      apiKey,
      updatedAt
    };
  }

  if (record.type === "oauth") {
    const accessToken = record.accessToken.trim();
    if (!accessToken) {
      throw new Error("OAuth access token is required.");
    }

    return {
      type: "oauth",
      accessToken,
      ...(record.refreshToken?.trim() ? { refreshToken: record.refreshToken.trim() } : {}),
      ...(Number.isFinite(record.expiresAt) ? { expiresAt: record.expiresAt } : {}),
      ...(record.accountId?.trim() ? { accountId: record.accountId.trim() } : {}),
      ...(record.extra ? { extra: { ...record.extra } } : {}),
      updatedAt
    };
  }

  const key = record.key.trim();
  const token = record.token.trim();
  if (!key || !token) {
    throw new Error("Well-known key and token are required.");
  }

  return {
    type: "wellknown",
    key,
    token,
    updatedAt
  };
}

function cloneAuthMap(input: ProviderAuthMap): ProviderAuthMap {
  return Object.fromEntries(
    Object.entries(input).map(([providerId, record]) => [providerId, { ...record }])
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
