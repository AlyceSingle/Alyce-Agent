import {
  createCodexConnector,
  type CodexConnectorOptions
} from "./codex.experimental.js";
import {
  createGitHubCopilotConnector,
  type GitHubCopilotConnectorOptions
} from "./githubCopilot.experimental.js";
import type { ProviderConnector } from "../providerAuth.js";

export interface BuiltInProviderConnectorOptions {
  githubCopilot?: GitHubCopilotConnectorOptions;
  codex?: CodexConnectorOptions;
  includeExperimental?: boolean;
}

export function getBuiltInProviderConnectors(
  options: BuiltInProviderConnectorOptions = {}
): ProviderConnector[] {
  if (options.includeExperimental === false) {
    return [];
  }

  return [
    createGitHubCopilotConnector(options.githubCopilot),
    createCodexConnector(options.codex)
  ];
}

export {
  createCodexConnector,
  refreshCodexAuth,
  rewriteCodexRequest,
  generatePKCE,
  extractAccountId
} from "./codex.experimental.js";
export {
  createGitHubCopilotConnector,
  normalizeDomain,
  getGitHubDeviceUrls
} from "./githubCopilot.experimental.js";
