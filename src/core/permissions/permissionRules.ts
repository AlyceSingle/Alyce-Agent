export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionCategory =
  | "shell"
  | "powershell"
  | "file.read"
  | "file.write"
  | "file.edit"
  | "file.patch"
  | "directory.external"
  | "web.fetch"
  | "web.search"
  | "mcp.tool"
  | "mcp.resource"
  | "skill.load"
  | "task.spawn";

export type PermissionRulePermission = PermissionCategory | "*";

export type PermissionRuleSource =
  | "built-in-default"
  | "session-approval"
  | "project-settings"
  | "user-settings"
  | "plan-mode-overlay";

export type PermissionRuleScope = "session" | "persistent";

export interface PermissionRuleInput {
  permission: PermissionRulePermission;
  pattern?: string;
  action: PermissionAction;
  scope?: PermissionRuleScope;
  expiresAt?: string;
  reason?: string;
  id?: string;
}

export interface PermissionRule extends PermissionRuleInput {
  source: PermissionRuleSource;
}

export interface PermissionRuleSet {
  source: PermissionRuleSource;
  rules: PermissionRule[];
}

export interface PermissionRequest {
  permission: PermissionCategory;
  pattern?: string;
}

export interface PermissionEvaluation {
  action: PermissionAction;
  permission: PermissionCategory;
  pattern: string;
  matchedRule: PermissionRule | null;
  reason: string;
}

export interface PermissionEvaluationOptions {
  permission: PermissionCategory;
  pattern?: string;
  rulesets?: PermissionRuleSet[];
  now?: Date;
}

const DEFAULT_PATTERN = "*";

const SOURCE_PRIORITY: Record<PermissionRuleSource, number> = {
  "built-in-default": 10,
  "project-settings": 20,
  "user-settings": 30,
  "session-approval": 40,
  "plan-mode-overlay": 50
};

const ACTION_PRIORITY: Record<PermissionAction, number> = {
  ask: 10,
  allow: 20,
  deny: 30
};

const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  {
    permission: "file.read",
    pattern: "sensitive:*",
    action: "ask",
    source: "built-in-default",
    reason: "Sensitive file reads must be approved."
  },
  {
    permission: "file.read",
    pattern: "workspace:*",
    action: "allow",
    source: "built-in-default",
    reason: "Workspace reads are allowed by default."
  },
  {
    permission: "directory.external",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "External directory access must be approved."
  },
  {
    permission: "file.write",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "File writes must be approved."
  },
  {
    permission: "file.edit",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "File edits must be approved."
  },
  {
    permission: "file.patch",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "Patch application must be approved."
  },
  {
    permission: "shell",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "Shell commands must be approved."
  },
  {
    permission: "powershell",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "PowerShell commands must be approved."
  },
  {
    permission: "web.fetch",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "Web fetch requests must be approved."
  },
  {
    permission: "web.search",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "Web search requests must be approved."
  },
  {
    permission: "mcp.tool",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "MCP tool calls must be approved."
  },
  {
    permission: "mcp.resource",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "MCP resource access must be approved."
  },
  {
    permission: "skill.load",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "Skill loading must be approved."
  },
  {
    permission: "task.spawn",
    pattern: "*",
    action: "ask",
    source: "built-in-default",
    reason: "Subagent task launch must be approved."
  }
];

export const PERMISSION_CATEGORIES: readonly PermissionCategory[] = [
  "shell",
  "powershell",
  "file.read",
  "file.write",
  "file.edit",
  "file.patch",
  "directory.external",
  "web.fetch",
  "web.search",
  "mcp.tool",
  "mcp.resource",
  "skill.load",
  "task.spawn"
];

export const PERMISSION_RULE_SOURCES: readonly PermissionRuleSource[] = [
  "built-in-default",
  "session-approval",
  "project-settings",
  "user-settings",
  "plan-mode-overlay"
];

export function createDefaultPermissionRuleSet(): PermissionRuleSet {
  return {
    source: "built-in-default",
    rules: DEFAULT_PERMISSION_RULES.map((rule) => ({ ...rule }))
  };
}

export function createPermissionRuleSet(
  source: PermissionRuleSource,
  rules: readonly PermissionRuleInput[] | undefined
): PermissionRuleSet {
  return {
    source,
    rules: (rules ?? []).map((rule) => ({
      ...rule,
      pattern: normalizePattern(rule.pattern),
      source
    }))
  };
}

export function evaluatePermission(
  options: PermissionEvaluationOptions
): PermissionEvaluation {
  const pattern = normalizePattern(options.pattern);
  const now = options.now ?? new Date();
  const rulesets = options.rulesets ?? [createDefaultPermissionRuleSet()];
  const matchingRules = flattenRulesets(rulesets)
    .filter((rule) => !isRuleExpired(rule, now))
    .filter((rule) => isPermissionMatch(rule.permission, options.permission))
    .filter((rule) => isPatternMatch(rule.pattern ?? DEFAULT_PATTERN, pattern));

  if (matchingRules.length === 0) {
    return {
      action: "ask",
      permission: options.permission,
      pattern,
      matchedRule: null,
      reason: `No permission rule matched ${options.permission}:${pattern}; defaulting to ask.`
    };
  }

  const matchedRule = [...matchingRules].sort(comparePermissionRules)[0]!;
  return {
    action: matchedRule.action,
    permission: options.permission,
    pattern,
    matchedRule,
    reason: formatEvaluationReason(matchedRule)
  };
}

export function matchesPermissionRule(
  rule: Pick<PermissionRuleInput, "permission" | "pattern">,
  request: PermissionRequest
): boolean {
  return isPermissionMatch(rule.permission, request.permission) &&
    isPatternMatch(rule.pattern ?? DEFAULT_PATTERN, normalizePattern(request.pattern));
}

export function getPermissionCategoriesForToolKind(
  kind: string,
  toolName?: string
): PermissionCategory[] {
  if (kind === "command") {
    return toolName === "PowerShell" ? ["powershell"] : ["shell"];
  }

  if (kind === "file-write") {
    if (toolName === "Edit" || toolName === "MultiEdit") {
      return ["file.edit"];
    }
    if (toolName === "apply_patch") {
      return ["file.patch"];
    }
    return ["file.write"];
  }

  if (kind === "file-read") {
    return ["file.read"];
  }

  if (kind === "external-directory") {
    return ["directory.external"];
  }

  if (kind === "web") {
    return toolName === "WebSearch" ? ["web.search"] : ["web.fetch"];
  }

  if (kind === "mcp") {
    return toolName && !["McpStatus", "ListMcpResources", "ReadMcpResource"].includes(toolName)
      ? ["mcp.tool"]
      : ["mcp.resource"];
  }

  if (kind === "skill") {
    return ["skill.load"];
  }

  if (kind === "agent") {
    return ["task.spawn"];
  }

  return [];
}

export function getPermissionCategoriesForLegacyKind(kind: string): PermissionCategory[] {
  if (kind === "command") {
    return ["shell", "powershell"];
  }

  if (kind === "file-write") {
    return ["file.write", "file.edit", "file.patch"];
  }

  if (kind === "web") {
    return ["web.fetch", "web.search"];
  }

  if (kind === "mcp") {
    return ["mcp.tool", "mcp.resource"];
  }

  return getPermissionCategoriesForToolKind(kind);
}

export function normalizePermissionPattern(value: string | undefined): string {
  return normalizePattern(value);
}

function flattenRulesets(rulesets: readonly PermissionRuleSet[]): PermissionRule[] {
  return rulesets.flatMap((ruleset) =>
    ruleset.rules.map((rule) => ({
      ...rule,
      source: rule.source ?? ruleset.source,
      pattern: normalizePattern(rule.pattern)
    }))
  );
}

function comparePermissionRules(left: PermissionRule, right: PermissionRule): number {
  if (left.action === "deny" || right.action === "deny") {
    const denyComparison = ACTION_PRIORITY[right.action] - ACTION_PRIORITY[left.action];
    if (denyComparison !== 0) {
      return denyComparison;
    }
  }

  const sourceComparison = SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source];
  if (sourceComparison !== 0) {
    return sourceComparison;
  }

  const actionComparison = ACTION_PRIORITY[right.action] - ACTION_PRIORITY[left.action];
  if (actionComparison !== 0) {
    return actionComparison;
  }

  const specificityComparison =
    patternSpecificity(right.pattern ?? DEFAULT_PATTERN) -
    patternSpecificity(left.pattern ?? DEFAULT_PATTERN);
  if (specificityComparison !== 0) {
    return specificityComparison;
  }

  return 0;
}

function isPermissionMatch(rulePermission: PermissionRulePermission, permission: PermissionCategory): boolean {
  return rulePermission === "*" || rulePermission === permission;
}

function isPatternMatch(rulePattern: string, requestPattern: string): boolean {
  if (rulePattern === DEFAULT_PATTERN) {
    return true;
  }

  return wildcardToRegExp(rulePattern).test(requestPattern);
}

function wildcardToRegExp(pattern: string): RegExp {
  const wildcardPattern = [...pattern]
    .map((char) => {
      if (char === "*") {
        return ".*";
      }

      if (char === "?") {
        return ".";
      }

      return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${wildcardPattern}$`, process.platform === "win32" ? "i" : "");
}

function patternSpecificity(pattern: string): number {
  return pattern.replace(/[*?]/g, "").length;
}

function normalizePattern(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_PATTERN;
}

function isRuleExpired(rule: PermissionRule, now: Date): boolean {
  if (!rule.expiresAt) {
    return false;
  }

  const expiresAt = new Date(rule.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime();
}

function formatEvaluationReason(rule: PermissionRule): string {
  const pattern = rule.pattern ?? DEFAULT_PATTERN;
  const base = `${rule.source} ${rule.action} matched ${rule.permission}:${pattern}.`;
  return rule.reason ? `${base} ${rule.reason}` : base;
}
