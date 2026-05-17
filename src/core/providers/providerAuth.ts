import type {
  AuthStore,
  ProviderAuthRecord,
  ProviderAuthRecordInput
} from "../auth/authStore.js";
import type { ModelProfile, ProviderProfile } from "./types.js";

export type AuthPrompt =
  | {
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      secret?: boolean;
      when?: AuthPromptCondition;
    }
  | {
      type: "select";
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      when?: AuthPromptCondition;
    };

export interface AuthPromptCondition {
  key: string;
  op: "eq" | "neq";
  value: string;
}

export interface AuthCallbackOptions {
  signal?: AbortSignal;
}

export type AuthFlow =
  | {
      method: "auto";
      url: string;
      instructions: string;
      callback: (options?: AuthCallbackOptions) => Promise<ProviderAuthRecordInput>;
    }
  | {
      method: "code";
      url: string;
      instructions: string;
      callback: (code: string, options?: AuthCallbackOptions) => Promise<ProviderAuthRecordInput>;
    };

export type AuthAuthorizeResult = ProviderAuthRecordInput | AuthFlow;

export type AuthMethod =
  | {
      type: "api";
      label: string;
      prompts?: AuthPrompt[];
      authorize?: (inputs: Record<string, string>) => Promise<ProviderAuthRecordInput>;
    }
  | {
      type: "oauth";
      label: string;
      prompts?: AuthPrompt[];
      authorize: (inputs: Record<string, string>) => Promise<AuthFlow>;
    }
  | {
      type: "wellknown";
      label: string;
      prompts?: AuthPrompt[];
      authorize: (inputs: Record<string, string>) => Promise<ProviderAuthRecordInput>;
    };

export interface ProviderRuntimeOptions {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  models?: Record<string, ModelProfile>;
}

export interface ProviderConnector {
  id: string;
  label: string;
  experimental?: boolean;
  auth?: {
    methods: AuthMethod[];
    loader?: (input: {
      getAuth: () => Promise<ProviderAuthRecord | undefined>;
      provider: ProviderProfile;
    }) => Promise<Partial<ProviderRuntimeOptions>>;
  };
  models?: (input: {
    provider: ProviderProfile;
    auth?: ProviderAuthRecord;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }) => Promise<Record<string, ModelProfile>>;
}

export interface ProviderAuthPendingFlow {
  providerId: string;
  methodIndex: number;
  flow: AuthFlow;
}

export class ProviderAuthService {
  private pending = new Map<string, ProviderAuthPendingFlow>();

  constructor(
    private readonly connectors: ProviderConnector[],
    private readonly authStore: AuthStore
  ) {}

  methods(providerId: string): AuthMethod[] {
    return this.getConnector(providerId)?.auth?.methods ?? [];
  }

  async authorize(
    providerId: string,
    methodIndex: number,
    inputs: Record<string, string> = {}
  ): Promise<
    | { type: "stored"; auth: ProviderAuthRecord }
    | { type: "flow"; flow: AuthFlow }
  > {
    const normalizedProviderId = normalizeProviderId(providerId);
    const method = this.getMethod(providerId, methodIndex);
    let result: AuthAuthorizeResult;
    if (method.type === "api") {
      result = method.authorize
        ? await method.authorize(inputs)
        : {
            type: "api",
            apiKey: inputs.apiKey ?? inputs.key ?? ""
          };
    } else {
      result = await method.authorize(inputs);
    }

    if (isAuthFlow(result)) {
      this.pending.set(flowKey(normalizedProviderId, methodIndex), {
        providerId: normalizedProviderId,
        methodIndex,
        flow: result
      });
      return { type: "flow", flow: result };
    }

    await this.authStore.set(normalizedProviderId, result);
    const auth = this.authStore.get(normalizedProviderId);
    if (!auth) {
      throw new Error(`AuthStore did not persist provider '${providerId}'.`);
    }

    return { type: "stored", auth };
  }

  async callback(
    providerId: string,
    methodIndex: number,
    code?: string,
    options: AuthCallbackOptions = {}
  ): Promise<ProviderAuthRecord> {
    const normalizedProviderId = normalizeProviderId(providerId);
    const key = flowKey(normalizedProviderId, methodIndex);
    const pending = this.pending.get(key);
    if (!pending) {
      throw new Error(`No pending auth flow for provider '${providerId}' method ${methodIndex}.`);
    }

    if (isAuthCancelled(options.signal)) {
      this.pending.delete(key);
      throw new Error("Provider auth flow was cancelled.");
    }
    let auth: ProviderAuthRecordInput;
    try {
      auth = pending.flow.method === "code"
        ? await pending.flow.callback(code ?? "", options)
        : await pending.flow.callback(options);
    } catch (error) {
      if (isAuthCancelled(options.signal) || this.pending.get(key) !== pending) {
        this.pending.delete(key);
        throw new Error("Provider auth flow was cancelled.");
      }

      throw error;
    }

    if (isAuthCancelled(options.signal)) {
      this.pending.delete(key);
      throw new Error("Provider auth flow was cancelled.");
    }
    if (this.pending.get(key) !== pending) {
      throw new Error("Provider auth flow was cancelled.");
    }

    await this.authStore.set(normalizedProviderId, auth);
    this.pending.delete(key);
    const stored = this.authStore.get(normalizedProviderId);
    if (!stored) {
      throw new Error(`AuthStore did not persist provider '${providerId}'.`);
    }

    return stored;
  }

  clearPending(providerId?: string) {
    if (!providerId) {
      this.pending.clear();
      return;
    }

    const normalizedProviderId = normalizeProviderId(providerId);
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${normalizedProviderId}:`)) {
        this.pending.delete(key);
      }
    }
  }

  getPendingFlow(providerId: string, methodIndex: number): AuthFlow | undefined {
    return this.pending.get(flowKey(normalizeProviderId(providerId), methodIndex))?.flow;
  }

  connector(providerId: string): ProviderConnector | undefined {
    const normalizedProviderId = normalizeProviderId(providerId);
    return this.connectors.find((connector) => normalizeProviderId(connector.id) === normalizedProviderId);
  }

  private getConnector(providerId: string): ProviderConnector | undefined {
    return this.connector(providerId);
  }

  private getMethod(providerId: string, methodIndex: number): AuthMethod {
    const method = this.methods(providerId)[methodIndex];
    if (!method) {
      throw new Error(`No auth method ${methodIndex} for provider '${providerId}'.`);
    }

    return method;
  }
}

function isAuthFlow(value: AuthAuthorizeResult): value is AuthFlow {
  return "method" in value && (value.method === "auto" || value.method === "code");
}

function flowKey(providerId: string, methodIndex: number): string {
  return `${normalizeProviderId(providerId)}:${methodIndex}`;
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function isAuthCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
