import type { SkillDescriptor, SkillPromptEntry } from "./types.js";

export function formatSkillContentMessage(skill: Pick<
  SkillDescriptor,
  | "name"
  | "description"
  | "content"
  | "baseDirectory"
  | "skillFilePath"
  | "sampleFiles"
> & {
  pluginId?: string;
  whenToUse?: string;
  allowedTools?: string[];
  activationPaths?: string[];
  dependencies?: Array<{ type: string; name: string }>;
  dependencyNotes?: string[];
}): string {
  const allowedTools = skill.allowedTools ?? [];
  const activationPaths = skill.activationPaths ?? [];
  const dependencyLabel = formatDependencies(skill.dependencies ?? []);
  const dependencyNotes = skill.dependencyNotes ?? [];
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
    ...(skill.pluginId ? [`Plugin: ${skill.pluginId}`] : []),
    ...(skill.whenToUse ? [`When to use: ${skill.whenToUse}`] : []),
    ...(allowedTools.length > 0
      ? [`Allowed tools: ${allowedTools.join(", ")}`]
      : []),
    ...(activationPaths.length > 0
      ? [`Activation paths: ${activationPaths.join(", ")}`]
      : []),
    ...(dependencyLabel ? [`Dependencies: ${dependencyLabel}`] : []),
    ...(dependencyNotes.length > 0
      ? ["Dependency notes:", ...dependencyNotes.map((note) => `- ${note}`)]
      : []),
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

export function extractSkillMentions(input: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const pattern = /(^|[\s(])\$([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    const rawName = match[2]?.trim();
    if (!rawName) {
      continue;
    }

    const normalized = rawName.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    mentions.push(rawName);
  }

  return mentions;
}

export function toPromptEntry(skill: SkillDescriptor): SkillPromptEntry {
  return {
    name: skill.name,
    source: skill.source,
    description: truncateText(skill.description, 180),
    shortDescription: truncateText(skill.shortDescription, 120),
    ...(skill.whenToUse ? { whenToUse: truncateText(skill.whenToUse, 180) } : {})
  };
}

export function formatPromptEntry(skill: SkillPromptEntry) {
  const description = skill.shortDescription || skill.description || "(no description)";
  const suffix = skill.whenToUse ? ` When to use: ${skill.whenToUse}` : "";
  return `- ${skill.name} [${skill.source}]: ${description}${suffix}`;
}

function truncateText(value: string, maxChars: number) {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function escapeXmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDependencies(dependencies: Array<{ type: string; name: string }>) {
  if (dependencies.length === 0) {
    return "";
  }

  return dependencies
    .map((dependency) => {
      if (dependency.type === "generic") {
        return dependency.name;
      }

      return `${dependency.type}:${dependency.name}`;
    })
    .join(", ");
}
