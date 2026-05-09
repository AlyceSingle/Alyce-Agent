import type { SessionSettings } from "../../config/runtime.js";
import type { TerminalUiMessage, TerminalUiToolData } from "../state/types.js";

const TOOL_MARKDOWN_FRIENDLY_NAME_TOKENS = [
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "codesearch"
] as const;

type ToolResultRenderMode = "code" | "plain" | "markdown";

const TOOL_RESULT_RENDER_MODE_MATRIX: Record<
  NonNullable<TerminalUiToolData["resultKind"]>,
  ToolResultRenderMode
> = {
  generic: "plain",
  shell: "code",
  write: "code",
  edit: "code",
  patch: "code",
  read: "plain"
};

const MARKDOWN_MESSAGE_KINDS: ReadonlySet<TerminalUiMessage["kind"]> = new Set([
  "assistant",
  "thinking"
]);

export type RenderFallbackReason =
  | "disabled"
  | "kind-not-supported"
  | "tool-not-eligible"
  | "tool-markdown-disabled"
  | "tool-code-preferred"
  | "tool-plain-preferred"
  | "collapsed-preview"
  | "content-too-long";

export type MessageRenderMode = "markdown" | "sections";

export type RenderPolicy = {
  version: "v2";
  markdownEnabled: boolean;
  markdownToolMessagesEnabled: boolean;
  markdownMaxChars: number;
  markdownMessageKinds: ReadonlySet<TerminalUiMessage["kind"]>;
};

export type RenderDecision = {
  mode: MessageRenderMode;
  live: boolean;
  fallbackReason?: RenderFallbackReason;
};

export function createRenderPolicy(
  settings: Pick<
    SessionSettings,
    "markdownMessageRenderingEnabled" | "markdownToolMessageRenderingEnabled" | "markdownRenderMaxChars"
  >
): RenderPolicy {
  return {
    version: "v2",
    markdownEnabled: settings.markdownMessageRenderingEnabled,
    markdownToolMessagesEnabled: settings.markdownToolMessageRenderingEnabled,
    markdownMaxChars: Math.max(1, Math.trunc(settings.markdownRenderMaxChars)),
    markdownMessageKinds: MARKDOWN_MESSAGE_KINDS
  };
}

export function resolveMessageRenderDecision(options: {
  policy: RenderPolicy;
  message: TerminalUiMessage;
  expanded: boolean;
  hasExpandablePreview: boolean;
  live: boolean;
  markdownSource: string;
}): RenderDecision {
  if (!options.policy.markdownEnabled) {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "disabled"
    };
  }

  if (options.policy.markdownMessageKinds.has(options.message.kind)) {
    if (!isMarkdownWithinBudget(options.policy, options.markdownSource)) {
      return {
        mode: "sections",
        live: false,
        fallbackReason: "content-too-long"
      };
    }

    return {
      mode: "markdown",
      live: options.live
    };
  }

  if (options.message.kind !== "tool") {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "kind-not-supported"
    };
  }

  const toolData = options.message.toolData;
  if (!toolData || toolData.phase !== "result" || toolData.ok !== true) {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "tool-not-eligible"
    };
  }

  if (!options.policy.markdownToolMessagesEnabled) {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "tool-markdown-disabled"
    };
  }

  const toolResultRenderMode = resolveToolResultRenderMode(toolData);
  if (toolResultRenderMode === "code") {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "tool-code-preferred"
    };
  }

  if (toolResultRenderMode === "plain") {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "tool-plain-preferred"
    };
  }

  if (!options.expanded && options.hasExpandablePreview) {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "collapsed-preview"
    };
  }

  if (!isMarkdownWithinBudget(options.policy, options.markdownSource)) {
    return {
      mode: "sections",
      live: false,
      fallbackReason: "content-too-long"
    };
  }

  return {
    mode: "markdown",
    live: false
  };
}

function resolveToolResultRenderMode(toolData: TerminalUiToolData): ToolResultRenderMode {
  const resultKind = toolData.resultKind ?? "generic";
  const baseMode = TOOL_RESULT_RENDER_MODE_MATRIX[resultKind];
  if (baseMode === "code") {
    return baseMode;
  }

  return isMarkdownFriendlyToolName(toolData.toolName) ? "markdown" : baseMode;
}

function isMarkdownFriendlyToolName(toolName: string) {
  const normalizedToolName = toolName.trim().toLowerCase();
  return TOOL_MARKDOWN_FRIENDLY_NAME_TOKENS.some((token) => normalizedToolName.includes(token));
}

function isMarkdownWithinBudget(policy: RenderPolicy, content: string) {
  return content.length <= policy.markdownMaxChars;
}
