import { z } from "zod";
import { createSkillContextMessage } from "../../core/api/generatedMessages.js";
import {
  collectSkillDependencyNotices,
  formatSkillDependencyNotices
} from "../../skills/dependencies.js";
import {
  SkillService,
  formatSkillContentMessage,
  type SkillDescriptor,
  type SkillDiscoveryRoots,
  type SkillMetadata
} from "../../skills/service.js";
export {
  discoverSkills,
  discoverSkillsFromRoot,
  formatSkillContentMessage,
  parseSkillMarkdown
} from "../../skills/service.js";
import { createToolResultEnvelope } from "../resultEnvelope.js";
import type { ToolExecutionContext } from "../types.js";

export const SKILL_TOOL_NAME = "SkillTool";

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

export type { SkillMetadata, SkillDescriptor, SkillDiscoveryRoots };

export interface SkillLoadResult {
  status: "loaded";
  name: string;
  description: string;
  location: string;
  source: SkillDescriptor["source"];
  baseDirectory: string;
  contentLength: number;
  pluginId?: string;
  sampleFiles: string[];
  duplicatePaths: string[];
  dependencyWarnings: string[];
  message: string;
}

export async function executeSkillTool(
  input: z.infer<typeof SkillToolInputSchema>,
  context: ToolExecutionContext
) {
  const skillService = new SkillService({
    workspaceRoot: context.workspaceRoot,
    watch: false
  });
  const requestedName = input.name.trim();
  const lookup = await skillService.findSkillByName(requestedName, { includeDisabled: true });
  const discovery = lookup.catalog;
  const skill = lookup.skill;

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

  if (lookup.disabled) {
    return {
      status: "error",
      error: "disabled_skill",
      message: `Skill '${requestedName}' is disabled.`,
      disabledReason: skill.disabledReason ?? "disabled by config",
      availableSkills: discovery.skills.map((candidate) => ({
        name: candidate.name,
        description: candidate.description,
        source: candidate.source,
        location: candidate.skillFilePath
      })),
      duplicateWarnings: discovery.duplicateWarnings
    };
  }

  const dependencyWarnings = formatSkillDependencyNotices(
    await collectSkillDependencyNotices(
      [skill],
      context.mcpRuntime,
      { abortSignal: context.abortSignal }
    )
  );
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
      ...(dependencyWarnings.length > 0
        ? dependencyWarnings.slice(0, 3)
        : []),
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
    ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
    sampleFiles: skill.sampleFiles,
    duplicatePaths: skill.duplicatePaths,
    dependencyWarnings,
    message: [
      `Loaded skill '${skill.name}'. Its SKILL.md content is attached as generated context for the next model step.`,
      ...dependencyWarnings
    ].join("\n")
  };

  return createToolResultEnvelope(result, [
    createSkillContextMessage(formatSkillContentMessage({
      ...skill,
      dependencyNotes: dependencyWarnings
    }))
  ]);
}
