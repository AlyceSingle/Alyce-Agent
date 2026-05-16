import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolPermissionPolicy } from "../types.js";

export interface SubagentDefinition {
  type: string;
  label: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  policy: ToolPermissionPolicy;
  maxSteps?: number;
  model?: string;
  source?: "built-in" | "custom";
  internal?: boolean;
}

const SHARED_SUBAGENT_RULES = [
  "You are a subagent running inside Alyce. Complete the delegated task autonomously.",
  "Your final response is returned to the parent agent, not directly to the user.",
  "Keep the final response concise and include the key findings, changed files, verification performed, and remaining risks when relevant.",
  "Do not assume prior conversation context. Use only this prompt, the system instructions, and tool results.",
  "Do not spawn other agents. Finish the assigned work directly with your available tools."
].join("\n");

export const SUBAGENT_DEFINITIONS: SubagentDefinition[] = [
  {
    type: "auto-reviewer",
    label: "Auto Reviewer",
    description:
      "Internal read-only approval reviewer for eligible permission requests.",
    allowedTools: [],
    policy: {
      allowWrite: false,
      allowNetwork: false,
      shell: "none"
    },
    maxSteps: 2,
    internal: true,
    systemPrompt: [
      SHARED_SUBAGENT_RULES,
      "",
      "You are deciding whether one pending Alyce permission request should be approved.",
      "Use only the request details supplied in the assignment. Do not call tools.",
      "Approve only when the request is clearly consistent with the user's task and low risk.",
      "Reject requests that are destructive, expose secrets, expand trust broadly, access unrelated paths, or are ambiguous.",
      "Return only strict JSON: {\"decision\":\"approve\"|\"reject\",\"confidence\":0.0-1.0,\"reason\":\"short reason\"}."
    ].join("\n")
  },
  {
    type: "general",
    label: "General",
    description:
      "General-purpose agent for complex research, codebase investigation, and bounded implementation tasks.",
    allowedTools: [
      "AskUserQuestion",
      "Read",
      "Glob",
      "Grep",
      "LSP",
      "Edit",
      "MultiEdit",
      "apply_patch",
      "Write",
      "Bash",
      "PowerShell",
      "WebFetch",
      "WebSearch"
    ],
    policy: {
      allowWrite: true,
      allowNetwork: true,
      shell: "any"
    },
    maxSteps: 8,
    systemPrompt: [
      SHARED_SUBAGENT_RULES,
      "",
      "You may research and implement when the prompt explicitly asks for implementation.",
      "Prefer reading exact files before editing. Keep changes scoped to the delegated task.",
      "Avoid creating new files unless they are necessary for the requested implementation."
    ].join("\n")
  },
  {
    type: "explore",
    label: "Explore",
    description:
      "Read-only specialist for fast codebase exploration, broad search, and architecture questions.",
    allowedTools: [
      "AskUserQuestion",
      "Read",
      "Glob",
      "Grep",
      "LSP",
      "Bash",
      "PowerShell"
    ],
    policy: {
      allowWrite: false,
      allowNetwork: false,
      shell: "read-only"
    },
    maxSteps: 6,
    systemPrompt: [
      SHARED_SUBAGENT_RULES,
      "",
      "This is a read-only exploration task. Do not create, edit, delete, move, copy, or format files.",
      "Search broadly first, then read the most relevant files. Report concrete file paths and line references when useful."
    ].join("\n")
  },
  {
    type: "review",
    label: "Review",
    description:
      "Read-only review agent for independent bug, regression, risk, and test-gap analysis.",
    allowedTools: [
      "AskUserQuestion",
      "Read",
      "Glob",
      "Grep",
      "LSP",
      "Bash",
      "PowerShell"
    ],
    policy: {
      allowWrite: false,
      allowNetwork: false,
      shell: "read-only"
    },
    maxSteps: 6,
    systemPrompt: [
      SHARED_SUBAGENT_RULES,
      "",
      "Review stance: prioritize bugs, behavioral regressions, safety risks, and missing tests.",
      "Do not edit files. Use read-only tools and commands only.",
      "Lead with findings ordered by severity. Include file and line references when possible. Say clearly if no issues are found."
    ].join("\n")
  },
  {
    type: "verify",
    label: "Verify",
    description:
      "Read-only verification agent for running approved checks and producing a pass/fail/inconclusive verdict.",
    allowedTools: [
      "AskUserQuestion",
      "Read",
      "Glob",
      "Grep",
      "LSP",
      "Bash",
      "PowerShell"
    ],
    policy: {
      allowWrite: false,
      allowNetwork: false,
      shell: "read-only",
      allowBuildTest: true
    },
    maxSteps: 8,
    systemPrompt: [
      SHARED_SUBAGENT_RULES,
      "",
      "This is a verification task. Do not edit, create, delete, move, copy, or format project files.",
      "Use read-only inspection tools first to understand what should be verified.",
      "You may run existing build, test, lint, or typecheck commands after approval. Do not install dependencies, update lockfiles, start long-lived services, or run mutating git commands.",
      "If a requested check requires setup that would mutate the project beyond normal build/test output, report that limitation instead of doing it.",
      "Report each command you ran, its outcome, and the key evidence from stdout/stderr.",
      "End the final response with exactly one verdict line: Verdict: pass, Verdict: fail, or Verdict: inconclusive."
    ].join("\n")
  }
];

const BUILT_IN_SUBAGENTS_BY_TYPE = new Map(
  SUBAGENT_DEFINITIONS.map((agent) => [agent.type, { ...agent, source: "built-in" as const }])
);

export function getSubagentDefinition(type: string): SubagentDefinition | undefined {
  return BUILT_IN_SUBAGENTS_BY_TYPE.get(type);
}

export function getSubagentTypes() {
  return SUBAGENT_DEFINITIONS.filter(isPublicSubagent).map((agent) => agent.type);
}

export function formatSubagentList() {
  return SUBAGENT_DEFINITIONS.filter(isPublicSubagent).map(
    (agent) => `- ${agent.type}: ${agent.description} (Tools: ${agent.allowedTools.join(", ")})`
  ).join("\n");
}

export async function loadSubagentDefinitions(workspaceRoot: string): Promise<SubagentDefinition[]> {
  const custom = await loadCustomSubagents(workspaceRoot);
  const merged = new Map<string, SubagentDefinition>();
  for (const agent of SUBAGENT_DEFINITIONS) {
    merged.set(agent.type, { ...agent, source: "built-in" });
  }
  for (const agent of custom) {
    if (merged.get(agent.type)?.internal === true) {
      continue;
    }

    merged.set(agent.type, agent);
  }

  return [...merged.values()];
}

function isPublicSubagent(agent: Pick<SubagentDefinition, "internal">) {
  return agent.internal !== true;
}

export function isInternalSubagentType(type: string) {
  return getSubagentDefinition(type)?.internal === true;
}

export async function loadSubagentDefinition(
  workspaceRoot: string,
  type: string
): Promise<SubagentDefinition | undefined> {
  const definitions = await loadSubagentDefinitions(workspaceRoot);
  return definitions.find((agent) => agent.type === type);
}

interface CustomSubagentFile {
  type?: unknown;
  name?: unknown;
  label?: unknown;
  description?: unknown;
  tools?: unknown;
  allowedTools?: unknown;
  systemPrompt?: unknown;
  prompt?: unknown;
  maxSteps?: unknown;
  model?: unknown;
  permissions?: unknown;
  policy?: unknown;
}

async function loadCustomSubagents(workspaceRoot: string): Promise<SubagentDefinition[]> {
  const agentsDirectory = path.join(workspaceRoot, ".alyce", "agents");
  let entries: string[];
  try {
    entries = await fs.readdir(agentsDirectory);
  } catch {
    return [];
  }

  const definitions: SubagentDefinition[] = [];
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    const extension = path.extname(entry).toLowerCase();
    if (extension !== ".json" && extension !== ".md") {
      continue;
    }

    try {
      const absolutePath = path.join(agentsDirectory, entry);
      const content = await fs.readFile(absolutePath, "utf8");
      const definition = extension === ".json"
        ? parseJsonSubagent(entry, content)
        : parseMarkdownSubagent(entry, content);
      if (definition) {
        definitions.push(definition);
      }
    } catch {
      // Invalid custom agents are ignored so a bad local file does not disable built-ins.
    }
  }

  return definitions;
}

function parseJsonSubagent(fileName: string, content: string): SubagentDefinition | undefined {
  const parsed = JSON.parse(content) as CustomSubagentFile;
  return normalizeCustomSubagent(fileName, parsed, asString(parsed.systemPrompt) ?? asString(parsed.prompt));
}

function parseMarkdownSubagent(fileName: string, content: string): SubagentDefinition | undefined {
  const frontmatter = content.match(/^---\r?\n(?<body>[\s\S]*?)\r?\n---\r?\n(?<prompt>[\s\S]*)$/);
  if (!frontmatter?.groups) {
    return normalizeCustomSubagent(fileName, {}, content.trim());
  }

  return normalizeCustomSubagent(
    fileName,
    parseSimpleYaml(frontmatter.groups.body),
    frontmatter.groups.prompt.trim()
  );
}

function normalizeCustomSubagent(
  fileName: string,
  input: CustomSubagentFile,
  prompt: string | undefined
): SubagentDefinition | undefined {
  const type = normalizeAgentType(asString(input.type) ?? asString(input.name) ?? path.basename(fileName, path.extname(fileName)));
  if (!type) {
    return undefined;
  }

  const allowedTools = normalizeStringList(input.allowedTools ?? input.tools);
  const systemPrompt = prompt?.trim();
  if (allowedTools.length === 0 || !systemPrompt) {
    return undefined;
  }

  return {
    type,
    label: asString(input.label) ?? type,
    description: asString(input.description) ?? "Custom subagent.",
    allowedTools,
    policy: normalizePolicy(input.policy ?? input.permissions),
    systemPrompt: [
      SHARED_SUBAGENT_RULES,
      "",
      systemPrompt
    ].join("\n"),
    ...(asPositiveInteger(input.maxSteps) ? { maxSteps: asPositiveInteger(input.maxSteps) } : {}),
    ...(asString(input.model) ? { model: asString(input.model) } : {}),
    source: "custom"
  };
}

function parseSimpleYaml(content: string): CustomSubagentFile {
  const result: Record<string, unknown> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    result[key] = parseYamlValue(rawValue);
  }

  return result;
}

function parseYamlValue(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => stripYamlQuotes(item.trim()))
      .filter(Boolean);
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "") {
    return numeric;
  }

  return stripYamlQuotes(value);
}

function stripYamlQuotes(value: string) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function normalizePolicy(value: unknown): ToolPermissionPolicy {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    allowWrite: asBoolean(record.allowWrite) ?? false,
    allowNetwork: asBoolean(record.allowNetwork) ?? false,
    shell: normalizeShellMode(record.shell),
    ...(asBoolean(record.allowBuildTest) === true ? { allowBuildTest: true } : {}),
    ...(normalizeStringList(record.allowedRoots).length > 0
      ? { allowedRoots: normalizeStringList(record.allowedRoots) }
      : {})
  };
}

function normalizeShellMode(value: unknown): ToolPermissionPolicy["shell"] {
  if (value === "any" || value === "read-only" || value === "none") {
    return value;
  }

  return "none";
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeAgentType(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
