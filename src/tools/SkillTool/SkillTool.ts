import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createSkillContextMessage } from "../../core/api/generatedMessages.js";
import { createToolResultEnvelope } from "../resultEnvelope.js";
import type { ToolExecutionContext } from "../types.js";

export const SKILL_TOOL_NAME = "SkillTool";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SAMPLE_FILES = 10;
const MAX_DISCOVERY_DEPTH = 8;

export const SkillToolInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .describe("Name of the local Alyce skill to load from .alyce/skills or ~/.alyce/skills")
  })
  .strict();

export const SKILL_TOOL_DESCRIPTION = [
  "Load a local Alyce skill by name and attach its SKILL.md instructions as context for the next model step.",
  "Skills are discovered from project .alyce/skills/**/SKILL.md and user ~/.alyce/skills/**/SKILL.md.",
  "Use this before following a specialized local workflow, tool convention, or reusable instruction set."
].join("\n");

export interface SkillMetadata {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, string>;
}

export interface SkillDescriptor {
  name: string;
  description: string;
  source: "project" | "user";
  skillFilePath: string;
  baseDirectory: string;
  content: string;
  sampleFiles: string[];
  duplicatePaths: string[];
}

export interface SkillDiscoveryRoots {
  projectRoot: string;
  userRoot: string;
}

export interface SkillLoadResult {
  status: "loaded";
  name: string;
  description: string;
  location: string;
  source: SkillDescriptor["source"];
  baseDirectory: string;
  contentLength: number;
  sampleFiles: string[];
  duplicatePaths: string[];
  message: string;
}

export async function executeSkillTool(
  input: z.infer<typeof SkillToolInputSchema>,
  context: ToolExecutionContext
) {
  const discovery = await discoverSkills({
    projectRoot: path.join(context.workspaceRoot, ".alyce", "skills"),
    userRoot: path.join(os.homedir(), ".alyce", "skills")
  });
  const requestedName = input.name.trim();
  const skill = findSkillByName(discovery.skills, requestedName);

  if (!skill) {
    return {
      status: "error",
      error: "unknown_skill",
      message: `Unknown skill: ${requestedName}`,
      availableSkills: discovery.skills.map((candidate) => ({
        name: candidate.name,
        description: candidate.description,
        source: candidate.source,
        location: candidate.skillFilePath
      })),
      duplicateWarnings: discovery.duplicateWarnings
    };
  }

  const approved = await context.requestApproval({
    kind: "skill",
    toolName: SKILL_TOOL_NAME,
    title: "Load local skill",
    summary: `${skill.name} (${skill.source})`,
    details: [
      `Skill: ${skill.name}`,
      `Source: ${skill.source}`,
      `Path: ${skill.skillFilePath}`,
      `Base directory: ${skill.baseDirectory}`,
      `Content length: ${skill.content.length} characters`,
      `Sample files: ${skill.sampleFiles.length}`,
      ...(skill.duplicatePaths.length > 0
        ? [`Duplicates shadowed: ${skill.duplicatePaths.length}`]
        : [])
    ]
  });

  if (!approved) {
    return {
      status: "rejected",
      name: skill.name,
      message: "User rejected the SkillTool request."
    };
  }

  const result: SkillLoadResult = {
    status: "loaded",
    name: skill.name,
    description: skill.description,
    location: skill.skillFilePath,
    source: skill.source,
    baseDirectory: skill.baseDirectory,
    contentLength: skill.content.length,
    sampleFiles: skill.sampleFiles,
    duplicatePaths: skill.duplicatePaths,
    message: `Loaded skill '${skill.name}'. Its SKILL.md content is attached as generated context for the next model step.`
  };

  return createToolResultEnvelope(result, [
    createSkillContextMessage(formatSkillContentMessage(skill))
  ]);
}

export async function discoverSkills(roots: SkillDiscoveryRoots): Promise<{
  skills: SkillDescriptor[];
  duplicateWarnings: string[];
}> {
  const [userSkills, projectSkills] = await Promise.all([
    discoverSkillsFromRoot(roots.userRoot, "user"),
    discoverSkillsFromRoot(roots.projectRoot, "project")
  ]);

  const selected = new Map<string, SkillDescriptor>();
  const duplicateWarnings: string[] = [];

  for (const skill of [...userSkills, ...projectSkills]) {
    const key = normalizeSkillName(skill.name);
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, skill);
      continue;
    }

    if (existing.source === "user" && skill.source === "project") {
      selected.set(key, {
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
    skills: [...selected.values()].sort(compareSkills),
    duplicateWarnings
  };
}

export async function discoverSkillsFromRoot(
  rootDirectory: string,
  source: SkillDescriptor["source"]
): Promise<SkillDescriptor[]> {
  const root = path.resolve(rootDirectory);
  const skillFiles = await findSkillFiles(root);
  const skills: SkillDescriptor[] = [];

  for (const skillFilePath of skillFiles) {
    try {
      const content = await fs.readFile(skillFilePath, "utf8");
      const baseDirectory = path.dirname(skillFilePath);
      const metadata = parseSkillMarkdown(content, baseDirectory);
      skills.push({
        name: metadata.name,
        description: metadata.description,
        source,
        skillFilePath,
        baseDirectory,
        content,
        sampleFiles: await sampleSkillFiles(baseDirectory),
        duplicatePaths: []
      });
    } catch {
      // Ignore unreadable or malformed skill files so one local skill cannot disable discovery.
    }
  }

  return skills.sort(compareSkills);
}

export function parseSkillMarkdown(content: string, baseDirectory: string): SkillMetadata {
  const parsed = splitFrontmatter(content);
  const frontmatter = parsed.frontmatter ? parseSimpleYaml(parsed.frontmatter) : {};
  const fallbackName = path.basename(baseDirectory);
  const name = normalizeDisplayValue(frontmatter.name) || fallbackName;
  const description =
    normalizeDisplayValue(frontmatter.description) ||
    extractFallbackDescription(parsed.body) ||
    "";

  return {
    name,
    description,
    body: parsed.body,
    frontmatter
  };
}

export function formatSkillContentMessage(skill: Pick<
  SkillDescriptor,
  "name" | "description" | "content" | "baseDirectory" | "skillFilePath" | "sampleFiles"
>): string {
  const lines = [
    "System-generated skill context from the SkillTool.",
    "This is not a new user request.",
    "Use this skill content as instructions for the current task.",
    "",
    `<skill_content name=${JSON.stringify(skill.name)}>`,
    `Skill file: ${skill.skillFilePath}`,
    `Base directory for this skill: ${skill.baseDirectory}`,
    "Relative paths in this skill are relative to this base directory.",
    skill.description ? `Description: ${skill.description}` : "Description: (none)",
    "",
    skill.content.trimEnd(),
    "",
    "<skill_files>",
    ...skill.sampleFiles.map((file) => `<file>${escapeXmlText(file)}</file>`),
    "</skill_files>",
    "</skill_content>"
  ];

  return lines.join("\n");
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

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
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
    if (key === "name" || key === "description") {
      result[key] = stripYamlQuotes(rawValue);
    }
  }

  return result;
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

function findSkillByName(skills: SkillDescriptor[], name: string): SkillDescriptor | undefined {
  const normalized = normalizeSkillName(name);
  return skills.find((skill) => normalizeSkillName(skill.name) === normalized);
}

function normalizeSkillName(name: string) {
  return name.trim().toLowerCase();
}

function normalizeDisplayValue(value: string | undefined) {
  return value?.trim() ?? "";
}

function compareSkills(left: SkillDescriptor, right: SkillDescriptor) {
  return left.name.localeCompare(right.name) ||
    left.source.localeCompare(right.source) ||
    left.skillFilePath.localeCompare(right.skillFilePath);
}

function escapeXmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
