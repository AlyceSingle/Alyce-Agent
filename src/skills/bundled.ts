import { parseSkillMarkdown, normalizeSkillName } from "./loader.js";
import type { SkillDescriptor } from "./types.js";

interface BundledSkillDefinition {
  id: string;
  markdown: string;
  sampleFiles: string[];
}

const BUNDLED_SKILLS: BundledSkillDefinition[] = [
  {
    id: "code-review",
    markdown: [
      "---",
      "name: code-review",
      "description: Review a code change for bugs, regressions, and missing validation.",
      "short_description: Structured engineering code review workflow.",
      "when_to_use: Use when the user asks for a review or wants risks called out before merge.",
      "allowed_tools:",
      "  - Read",
      "  - Grep",
      "  - Bash",
      "user_invocable: true",
      "---",
      "# Code Review",
      "",
      "Review the actual diff and surrounding code before judging the change.",
      "",
      "Prioritize findings by severity and user impact.",
      "",
      "Call out concrete bugs, regressions, unsafe assumptions, and missing tests.",
      "",
      "Prefer file references and short, direct reasoning over broad commentary."
    ].join("\n"),
    sampleFiles: ["checklists/review-template.md"]
  },
  {
    id: "test-fix",
    markdown: [
      "---",
      "name: test-fix",
      "description: Debug failing tests, isolate the root cause, and fix with minimal scope.",
      "short_description: Workflow for fixing test failures efficiently.",
      "when_to_use: Use when the task starts from failing tests or verification regressions.",
      "allowed_tools:",
      "  - Read",
      "  - Edit",
      "  - Bash",
      "paths:",
      "  - package.json",
      "  - **/*.test.ts",
      "  - **/*.test.tsx",
      "user_invocable: true",
      "---",
      "# Test Fix",
      "",
      "Start by reproducing the failure with the smallest useful command.",
      "",
      "Trace the root cause before editing. Do not patch symptoms blindly.",
      "",
      "Keep the fix narrow, rerun the failing tests, then run the next relevant validation layer."
    ].join("\n"),
    sampleFiles: ["checklists/test-fix-template.md"]
  }
];

export function loadBundledSkills(): SkillDescriptor[] {
  return BUNDLED_SKILLS.map((definition) => createBundledSkill(definition));
}

export function validateBundledRelativePath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`Invalid bundled skill relative path: ${relativePath}`);
  }

  return normalized;
}

function createBundledSkill(definition: BundledSkillDefinition): SkillDescriptor {
  const baseDirectory = `bundled://${definition.id}`;
  const metadata = parseSkillMarkdown(definition.markdown, baseDirectory);

  return {
    id: `bundled:${normalizeSkillName(metadata.name)}:${definition.id}`,
    name: metadata.name,
    normalizedName: normalizeSkillName(metadata.name),
    description: metadata.description,
    shortDescription: metadata.shortDescription,
    ...(metadata.whenToUse ? { whenToUse: metadata.whenToUse } : {}),
    ...(metadata.version ? { version: metadata.version } : {}),
    allowedTools: metadata.allowedTools,
    ...(metadata.userInvocable !== undefined ? { userInvocable: metadata.userInvocable } : {}),
    activationPaths: metadata.activationPaths,
    dependencies: metadata.dependencies,
    source: "bundled",
    skillFilePath: `${baseDirectory}/SKILL.md`,
    baseDirectory,
    content: definition.markdown,
    sampleFiles: definition.sampleFiles.map((entry) => validateBundledRelativePath(entry)),
    duplicatePaths: []
  };
}
