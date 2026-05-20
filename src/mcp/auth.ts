import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpRemoteServerConfig } from "./types.js";

interface PersistedMcpOAuthEntry {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  updatedAt?: string;
}

interface PersistedMcpOAuthStore {
  entries?: Record<string, PersistedMcpOAuthEntry>;
}

interface PersistentMcpOAuthProviderOptions {
  serverName: string;
  serverConfig: McpRemoteServerConfig;
  redirectUrl?: string | URL;
  storePath?: string;
  clientMetadataUrl?: string;
  onRedirect?: (authorizationUrl: URL) => void;
}

interface WaitForAuthorizationCodeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpOAuthCallbackServer {
  redirectUrl: string;
  waitForAuthorizationCode: (options?: WaitForAuthorizationCodeOptions) => Promise<string>;
  close: () => Promise<void>;
}

export function getMcpAuthStorePath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".alyce", "mcp-auth.json");
}

export function createPersistentMcpOAuthProvider(
  options: PersistentMcpOAuthProviderOptions
): OAuthClientProvider {
  return new PersistentMcpOAuthProvider(options);
}

export async function createMcpOAuthCallbackServer(): Promise<McpOAuthCallbackServer> {
  let codeResolver: ((value: string) => void) | null = null;
  let codeRejecter: ((reason?: unknown) => void) | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    codeResolver = resolve;
    codeRejecter = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const authorizationCode = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (authorizationCode) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body>Authorization received. You can return to Alyce.</body></html>");
      codeResolver?.(authorizationCode);
      codeResolver = null;
      codeRejecter = null;
      return;
    }

    if (error) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body>Authorization failed. Return to Alyce to review the error.</body></html>");
      codeRejecter?.(new Error(errorDescription ? `${error}: ${errorDescription}` : error));
      codeResolver = null;
      codeRejecter = null;
      return;
    }

    response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body>Missing authorization code.</body></html>");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind local OAuth callback server.");
  }

  const redirectUrl = `http://127.0.0.1:${address.port}/callback`;

  return {
    redirectUrl,
    waitForAuthorizationCode: async (options = {}) => {
      let timeout: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const signal = options.signal;
      const timeoutMs = options.timeoutMs ?? 300_000;
      const races: Array<Promise<string>> = [codePromise];

      races.push(new Promise<string>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`OAuth authorization timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
      }));

      if (signal) {
        races.push(new Promise<string>((_resolve, reject) => {
          abortHandler = () => {
            reject(signal.reason instanceof Error
              ? signal.reason
              : new Error(String(signal.reason ?? "aborted")));
          };
          signal.addEventListener("abort", abortHandler, { once: true });
        }));
      }

      try {
        return await Promise.race(races);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (abortHandler && signal) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    },
    close: async () => {
      if (!server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

class PersistentMcpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private readonly redirectUrlValue?: string | URL;
  private readonly clientMetadataValue: OAuthClientMetadata;
  private readonly storePath: string;
  private readonly storeKey: string;
  private readonly onRedirect?: (authorizationUrl: URL) => void;

  constructor(options: PersistentMcpOAuthProviderOptions) {
    this.redirectUrlValue = options.redirectUrl;
    this.clientMetadataUrl = options.clientMetadataUrl;
    this.storePath = options.storePath ?? getMcpAuthStorePath();
    this.storeKey = createStoreKey(options.serverName, options.serverConfig);
    this.onRedirect = options.onRedirect;
    this.clientMetadataValue = {
      client_name: `Alyce MCP (${options.serverName})`,
      redirect_uris: options.redirectUrl ? [String(options.redirectUrl)] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "mcp:tools mcp:resources mcp:prompts"
    };
  }

  get redirectUrl() {
    return this.redirectUrlValue;
  }

  get clientMetadata() {
    return this.clientMetadataValue;
  }

  async clientInformation() {
    return (await this.readEntry()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    await this.updateEntry({ clientInformation });
  }

  async tokens() {
    return (await this.readEntry()).tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.updateEntry({ tokens });
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.onRedirect?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string) {
    await this.updateEntry({ codeVerifier });
  }

  async codeVerifier() {
    const codeVerifier = (await this.readEntry()).codeVerifier;
    if (!codeVerifier) {
      throw new Error("No OAuth code verifier saved for this MCP server.");
    }

    return codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState) {
    await this.updateEntry({ discoveryState });
  }

  async discoveryState() {
    return (await this.readEntry()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const store = await readStore(this.storePath);
    const current = store.entries?.[this.storeKey];
    if (!current) {
      return;
    }

    const next: PersistedMcpOAuthEntry =
      scope === "all"
        ? {}
        : {
            ...current,
            ...(scope === "client" ? { clientInformation: undefined } : {}),
            ...(scope === "tokens" ? { tokens: undefined } : {}),
            ...(scope === "verifier" ? { codeVerifier: undefined } : {}),
            ...(scope === "discovery" ? { discoveryState: undefined } : {})
          };

    const entries = { ...(store.entries ?? {}) };
    if (scope === "all" || isEmptyEntry(next)) {
      delete entries[this.storeKey];
    } else {
      entries[this.storeKey] = {
        ...next,
        updatedAt: new Date().toISOString()
      };
    }

    await writeStore(this.storePath, { entries });
  }

  private async readEntry(): Promise<PersistedMcpOAuthEntry> {
    const store = await readStore(this.storePath);
    return store.entries?.[this.storeKey] ?? {};
  }

  private async updateEntry(patch: PersistedMcpOAuthEntry) {
    const store = await readStore(this.storePath);
    const entries = { ...(store.entries ?? {}) };
    const current = entries[this.storeKey] ?? {};
    const next: PersistedMcpOAuthEntry = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    entries[this.storeKey] = next;
    await writeStore(this.storePath, { entries });
  }
}

function createStoreKey(serverName: string, serverConfig: McpRemoteServerConfig) {
  return `${serverName}\0${serverConfig.type}\0${serverConfig.url}`;
}

async function readStore(storePath: string): Promise<PersistedMcpOAuthStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedMcpOAuthStore;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { entries: {} };
    }

    return {
      entries: parsed.entries && typeof parsed.entries === "object"
        ? parsed.entries
        : {}
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { entries: {} };
    }

    throw error;
  }
}

async function writeStore(storePath: string, store: PersistedMcpOAuthStore) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

function isEmptyEntry(entry: PersistedMcpOAuthEntry) {
  return !entry.clientInformation &&
    !entry.tokens &&
    !entry.codeVerifier &&
    !entry.discoveryState;
}
