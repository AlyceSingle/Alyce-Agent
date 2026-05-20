import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  SkillCatalog,
  SkillDependency,
  SkillDescriptor,
  SkillDiscoveryRoots,
  SkillFrontmatterValue,
  SkillMetadata,
  SkillSource
} from "./types.js";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SAMPLE_FILES = 10;
const MAX_DISCOVERY_DEPTH = 8;
const SOURCE_PRIORITY: Record<SkillSource, number> = {
  project: 0,
  user: 1,
  bundled: 2
};

export async function discoverSkills(roots: SkillDiscoveryRoots): Promise<SkillCatalog> {
  const [userSkills, projectSkills] = await Promise.all([
    discoverSkillsFromRoot(roots.userRoot, "user"),
    discoverSkillsFromRoot(roots.projectRoot, "project")
  ]);

  const selected = new Map<string, SkillDescriptor>();
  const duplicateWarnings: string[] = [];

  for (const skill of [...userSkills, ...projectSkills]) {
    const existing = selected.get(skill.normalizedName);
    if (!existing) {
      selected.set(skill.normalizedName, skill);
      continue;
    }

    if (existing.source === "user" && skill.source === "project") {
      selected.set(skill.normalizedName, {
        ...skill,
        duplicatePaths: [existing.skillFilePath, ...skill.duplicatePaths]
      });
      duplicateWarnings.push(
        `Project skill '${skill.name}' overrides user skill at ${existing.skillFilePath}.`
      );
      continue;
    }

    existing.duplicatePaths.push(skill.skillFilePath);
    duplicateWarnings.push(
      `Duplicate skill '${skill.name}' ignored at ${skill.skillFilePath}; using ${existing.skillFilePath}.`
    );
  }

  return {
    skills: [...selected.values()].sort(compareDiscoveredSkills),
    disabledSkills: [],
    duplicateWarnings,
    disabledWarnings: [],
    configWarnings: []
  };
}

export async function discoverSkillsFromRoot(
  rootDirectory: string,
  source: Exclude<SkillSource, "bundled">
): Promise<SkillDescriptor[]> {
  const root = path.resolve(rootDirectory);
  const skillFiles = await findSkillFiles(root);
  const skills: SkillDescriptor[] = [];

  for (const skillFilePath of skillFiles) {
    try {
      const content = await fs.readFile(skillFilePath, "utf8");
      const baseDirectory = path.dirname(skillFilePath);
      const metadata = parseSkillMarkdown(content, baseDirectory);
      const normalizedName = normalizeSkillName(metadata.name);
      skills.push({
        id: createSkillId(source, metadata.name, skillFilePath),
        name: metadata.name,
        normalizedName,
        description: metadata.description,
        shortDescription: metadata.shortDescription,
        ...(metadata.whenToUse ? { whenToUse: metadata.whenToUse } : {}),
        ...(metadata.version ? { version: metadata.version } : {}),
        ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
        allowedTools: metadata.allowedTools,
        ...(metadata.userInvocable !== undefined ? { userInvocable: metadata.userInvocable } : {}),
        activationPaths: metadata.activationPaths,
        dependencies: metadata.dependencies,
        source,
        skillFilePath,
        baseDirectory,
        content,
        sampleFiles: await sampleSkillFiles(baseDirectory),
        duplicatePaths: []
      });
    } catch {
      // Keep discovery resilient: one malformed local skill should not hide the rest.
    }
  }

  return skills.sort(compareDiscoveredSkills);
}

export function parseSkillMarkdown(content: string, baseDirectory: string): SkillMetadata {
  const parsed = splitFrontmatter(content);
  const frontmatter = parsed.frontmatter ? parseSimpleFrontmatter(parsed.frontmatter) : {};
  const fallbackName = path.basename(baseDirectory);
  const name = normalizeTextValue(frontmatter.name) || fallbackName;
  const description =
    normalizeTextValue(frontmatter.description) ||
    extractFallbackDescription(parsed.body) ||
    "";
  const shortDescription = normalizeTextValue(frontmatter.shortDescription) || description;
  const whenToUse = normalizeTextValue(frontmatter.whenToUse);
  const version = normalizeTextValue(frontmatter.version);
  const pluginId = normalizeTextValue(frontmatter.pluginId);
  const allowedTools = normalizeStringArray(frontmatter.allowedTools);
  const userInvocable = normalizeBooleanValue(frontmatter.userInvocable);
  const activationPaths = normalizeStringArray(frontmatter.activationPaths);
  const dependencies = buildDependencies(frontmatter);

  return {
    name,
    description,
    shortDescription,
    ...(whenToUse ? { whenToUse } : {}),
    ...(version ? { version } : {}),
    ...(pluginId ? { pluginId } : {}),
    allowedTools,
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    activationPaths,
    dependencies,
    body: parsed.body,
    frontmatter
  };
}

export function compareDiscoveredSkills(left: SkillDescriptor, right: SkillDescriptor) {
  return SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] ||
    left.name.localeCompare(right.name) ||
    left.skillFilePath.localeCompare(right.skillFilePath);
}

export function findSkillByName(skills: SkillDescriptor[], name: string): SkillDescriptor | undefined {
  const normalized = normalizeSkillName(name);
  return skills.find((skill) => skill.normalizedName === normalized);
}

export function normalizeSkillName(name: string) {
  return name.trim().toLowerCase();
}

export function createSkillId(source: SkillSource, name: string, skillFilePath: string) {
  const hash = createHash("sha1")
    .update(path.resolve(skillFilePath))
    .digest("hex")
    .slice(0, 6);
  return `${source}:${normalizeSkillName(name)}:${hash}`;
}

function buildDependencies(frontmatter: Record<string, SkillFrontmatterValue>): SkillDependency[] {
  const generic = normalizeStringArray(frontmatter.dependencies).map((name) => ({
    type: "generic" as const,
    name
  }));
  const mcpServers = normalizeStringArray(frontmatter.mcpServers).map((name) => ({
    type: "mcp_server" as const,
    name
  }));
  const mcpTools = normalizeStringArray(frontmatter.mcpTools).map((name) => ({
    type: "mcp_tool" as const,
    name
  }));

  const selected = new Map<string, SkillDependency>();
  for (const dependency of [...generic, ...mcpServers, ...mcpTools]) {
    const key = `${dependency.type}:${dependency.name.toLowerCase()}`;
    if (!selected.has(key)) {
      selected.set(key, dependency);
    }
  }

  return [...selected.values()];
}

async function findSkillFiles(rootDirectory: string): Promise<string[]> {
  const results: string[] = [];
  await walkSkillDirectory(rootDirectory, rootDirectory, results, 0);
  return results.sort((left, right) => left.localeCompare(right));
}

async function walkSkillDirectory(
  rootDirectory: string,
  currentDirectory: string,
  results: string[],
  depth: number
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    return;
  }

  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>;
  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
      results.push(absolutePath);
      continue;
    }

    if (entry.isDirectory() && shouldDescendIntoSkillDirectory(rootDirectory, absolutePath)) {
      await walkSkillDirectory(rootDirectory, absolutePath, results, depth + 1);
    }
  }
}

function shouldDescendIntoSkillDirectory(rootDirectory: string, directoryPath: string) {
  const relative = path.relative(rootDirectory, directoryPath);
  return !relative.split(path.sep).some((part) =>
    part === "node_modules" ||
    part === ".git" ||
    part === "dist" ||
    part === "build" ||
    part.startsWith(".tmp")
  );
}

async function sampleSkillFiles(baseDirectory: string): Promise<string[]> {
  const files: string[] = [];
  await walkSampleFiles(baseDirectory, baseDirectory, files, 0);
  return files
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_SAMPLE_FILES);
}

async function walkSampleFiles(
  baseDirectory: string,
  currentDirectory: string,
  files: string[],
  depth: number
): Promise<void> {
  if (depth > 2 || files.length >= MAX_SAMPLE_FILES * 2) {
    return;
  }

  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>;
  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    if (entry.isFile()) {
      if (entry.name !== SKILL_FILE_NAME) {
        files.push(path.relative(baseDirectory, absolutePath));
      }
      continue;
    }

    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      await walkSampleFiles(baseDirectory, absolutePath, files, depth + 1);
    }
  }
}

function splitFrontmatter(content: string): { frontmatter?: string; body: string } {
  const match = content.match(/^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)(?<body>[\s\S]*)$/);
  if (!match?.groups) {
    return { body: content.trim() };
  }

  return {
    frontmatter: match.groups.frontmatter,
    body: match.groups.body.trim()
  };
}

function parseSimpleFrontmatter(content: string): Record<string, SkillFrontmatterValue> {
  const result: Record<string, SkillFrontmatterValue> = {};
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line?.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (!match) {
      continue;
    }

    const key = normalizeFrontmatterKey(match[1] ?? "");
    if (!key) {
      continue;
    }

    const rawValue = (match[2] ?? "").trim();
    if (rawValue.length > 0) {
      result[key] = parseFrontmatterScalar(rawValue);
      continue;
    }

    const arrayValues: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex] ?? "";
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed) {
        nextIndex += 1;
        continue;
      }

      if (nextTrimmed.startsWith("#")) {
        nextIndex += 1;
        continue;
      }

      const listMatch = nextLine.match(/^\s*-\s+(.*)$/);
      if (!listMatch) {
        break;
      }

      const value = stripYamlQuotes((listMatch[1] ?? "").trim());
      if (value) {
        arrayValues.push(value);
      }
      nextIndex += 1;
    }

    if (arrayValues.length > 0) {
      result[key] = arrayValues;
      index = nextIndex - 1;
      continue;
    }

    result[key] = "";
  }

  return result;
}

function normalizeFrontmatterKey(key: string): string | null {
  const normalized = key.trim().toLowerCase().replace(/-/g, "_");
  switch (normalized) {
    case "name":
      return "name";
    case "description":
      return "description";
    case "short_description":
      return "shortDescription";
    case "when_to_use":
      return "whenToUse";
    case "version":
      return "version";
    case "plugin_id":
      return "pluginId";
    case "allowed_tools":
      return "allowedTools";
    case "user_invocable":
      return "userInvocable";
    case "paths":
    case "activation_paths":
    case "activation.paths":
      return "activationPaths";
    case "mcp_servers":
      return "mcpServers";
    case "mcp_tools":
      return "mcpTools";
    case "dependencies":
      return "dependencies";
    case "scope":
      return "scope";
    default:
      return null;
  }
}

function parseFrontmatterScalar(value: string): SkillFrontmatterValue {
  const normalized = stripYamlQuotes(value.trim());
  if (/^(true|false)$/i.test(normalized)) {
    return normalized.toLowerCase() === "true";
  }

  return normalized;
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

function normalizeTextValue(value: SkillFrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeStringArray(value: SkillFrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }

  return [];
}

function normalizeBooleanValue(value: SkillFrontmatterValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function extractFallbackDescription(body: string) {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```")) {
      continue;
    }

    return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  }

  return undefined;
}
