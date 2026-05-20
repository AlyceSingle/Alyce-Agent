import type { SkillCatalog, SkillDescriptor } from "../skills/service.js";

export interface SkillCommandContext {
  projectRoot: string;
  userRoot: string;
  projectRootReady: boolean;
  userRootReady: boolean;
}

export function formatSkillList(
  catalog: SkillCatalog,
  context?: SkillCommandContext
): string {
  if (catalog.skills.length === 0 && catalog.disabledSkills.length === 0) {
    return [
      "Available skills",
      "No skills are currently discoverable.",
      ...(context ? [
        "",
        ...formatSkillRootLines(context),
        "",
        "No SKILL.md files were found in the local skill roots yet.",
        `Add a skill under ${context.projectRoot}\\<skill-name>\\SKILL.md or ${context.userRoot}\\<skill-name>\\SKILL.md.`
      ] : [])
    ].join("\n");
  }

  const lines = [
    "Available skills",
    `Active: ${catalog.skills.length}`,
    `Disabled: ${catalog.disabledSkills.length}`,
    ""
  ];

  if (catalog.skills.length > 0) {
    lines.push(...catalog.skills.map((skill) => formatSkillListEntry(skill)));
  } else {
    lines.push("(no active skills)");
  }

  appendSection(lines, "Disabled skills:", catalog.disabledSkills.map(formatDisabledSkillEntry));
  appendSection(lines, "Duplicate warnings:", catalog.duplicateWarnings.map(formatWarningEntry));
  appendSection(lines, "Disabled warnings:", catalog.disabledWarnings.map(formatWarningEntry));
  appendSection(lines, "Config warnings:", catalog.configWarnings.map(formatWarningEntry));

  lines.push(
    "",
    "Use /skills <name> for details, /skills enable|disable <name> to govern skills, or mention $<name> in your prompt to load an active skill before the next turn."
  );
  return lines.join("\n");
}

export function formatSkillDetails(
  skill: SkillDescriptor | undefined,
  requestedName: string,
  catalog?: SkillCatalog,
  context?: SkillCommandContext
): string {
  if (!skill) {
    const suggestions = catalog?.skills
      .slice(0, 12)
      .map((entry) => entry.name)
      .join(", ");
    return [
      `Unknown skill: ${requestedName}`,
      suggestions ? `Active skills: ${suggestions}` : "No active skills are currently available.",
      ...(context ? [
        "",
        ...formatSkillRootLines(context),
        `Add a local skill under ${context.projectRoot}\\<skill-name>\\SKILL.md or ${context.userRoot}\\<skill-name>\\SKILL.md.`
      ] : [])
    ].join("\n");
  }

  const lines = [
    `Skill ${skill.name}`,
    `Status: ${skill.disabledReason ? `disabled (${skill.disabledReason})` : "active"}`,
    `Source: ${skill.source}`,
    `Path: ${skill.skillFilePath}`,
    `Base directory: ${skill.baseDirectory}`,
    `Description: ${skill.description || "(none)"}`,
    ...(skill.shortDescription && skill.shortDescription !== skill.description
      ? [`Short description: ${skill.shortDescription}`]
      : []),
    ...(skill.whenToUse ? [`When to use: ${skill.whenToUse}`] : []),
    ...(skill.version ? [`Version: ${skill.version}`] : []),
    `User invocable: ${skill.userInvocable === false ? "no" : "yes"}`,
    `Allowed tools: ${skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "(not declared)"}`,
    `Activation paths: ${skill.activationPaths.length > 0 ? skill.activationPaths.join(", ") : "(not declared)"}`,
    `Dependencies: ${formatDependencies(skill)}`,
    `Sample files: ${skill.sampleFiles.length > 0 ? skill.sampleFiles.join(", ") : "(none)"}`,
    ...(skill.duplicatePaths.length > 0
      ? [`Shadowed duplicates: ${skill.duplicatePaths.join(", ")}`]
      : []),
    "",
    `Use $${skill.name} in a prompt to preload this skill, or let the model call SkillTool explicitly.`
  ];

  return lines.join("\n");
}

function formatSkillListEntry(skill: SkillDescriptor) {
  const description = skill.shortDescription || skill.description || "(no description)";
  const suffix = skill.whenToUse ? ` | when: ${skill.whenToUse}` : "";
  return `- ${skill.name} [${skill.source}] | ${description}${suffix}`;
}

function formatDisabledSkillEntry(skill: SkillDescriptor) {
  return `- ${skill.name} [${skill.source}] | ${skill.disabledReason ?? "disabled"}`;
}

function formatWarningEntry(warning: string) {
  return `- ${warning}`;
}

function appendSection(lines: string[], title: string, entries: string[]) {
  if (entries.length === 0) {
    return;
  }

  lines.push("", title, ...entries);
}

function formatDependencies(skill: SkillDescriptor) {
  if (skill.dependencies.length === 0) {
    return "(not declared)";
  }

  return skill.dependencies
    .map((dependency) => {
      if (dependency.type === "generic") {
        return dependency.name;
      }

      return `${dependency.type}:${dependency.name}`;
    })
    .join(", ");
}

function formatSkillRootLines(context: SkillCommandContext) {
  return [
    "Skill roots:",
    `- Project: ${context.projectRoot} (${context.projectRootReady ? "ready" : "unavailable"})`,
    `- User: ${context.userRoot} (${context.userRootReady ? "ready" : "unavailable"})`
  ];
}
