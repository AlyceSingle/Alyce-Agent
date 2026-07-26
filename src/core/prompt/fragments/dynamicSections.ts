import { sessionPromptSection, turnPromptSection } from "../sectionFactory.js";
import type { PromptBuildOptions, PromptRuntimeContext, PromptSection } from "../types.js";
import { promptFormatting } from "./formatting.js";

function hasTool(runtimeContext: PromptRuntimeContext, toolName: string) {
  return runtimeContext.availableTools.includes(toolName);
}

function getAvailableSkillsSection(runtimeContext: PromptRuntimeContext) {
  if (!hasTool(runtimeContext, "SkillTool")) {
    return null;
  }

  const skills = runtimeContext.availableSkills;
  if (!skills || skills.totalCount === 0 || skills.skills.length === 0) {
    return null;
  }

  const lines = [
    "Skills summary: the following Alyce skills are available for specialized local workflows in this session.",
    "",
    "# Available skills",
    "These are active Alyce skills discovered from bundled, project, and user skill roots.",
    "Mention $<skill-name> in a user prompt or use SkillTool to load one before following specialized local workflows.",
    "",
    ...skills.skills.map((skill) => {
      const description = skill.shortDescription || skill.description || "(no description)";
      const suffix = skill.whenToUse ? ` When to use: ${skill.whenToUse}` : "";
      return `- ${skill.name} [${skill.source}]: ${description}${suffix}`;
    })
  ];

  if (skills.truncatedCount > 0) {
    lines.push("", `- ... ${skills.truncatedCount} more skill(s) omitted to stay within the prompt budget.`);
  }

  return lines.join("\n");
}

function getMemorySection(runtimeContext: PromptRuntimeContext) {
  const sessionSummary = runtimeContext.memory?.sessionSummary?.trim();
  const sessionNotes = runtimeContext.memory?.sessionNotes ?? [];
  const persistentNotes = runtimeContext.memory?.persistentNotes ?? [];

  if (!sessionSummary && sessionNotes.length === 0 && persistentNotes.length === 0) {
    return null;
  }

  const lines: string[] = [
    "Memory summary: treat saved notes as durable hints and confirm them against current files and tool outputs.",
    "",
    "# Memory",
    "Use memory as durable hints, but confirm against current files and tool outputs."
  ];

  if (sessionSummary) {
    lines.push("", "## Session Memory Summary");
    if (runtimeContext.memory?.sessionMemoryPath) {
      lines.push(`Source: ${runtimeContext.memory.sessionMemoryPath}`);
    }
    lines.push(sessionSummary);
  }

  if (sessionNotes.length > 0) {
    lines.push("", "## Session Memory", ...promptFormatting.prependBullets(sessionNotes));
  }

  if (persistentNotes.length > 0) {
    lines.push("", "## Persistent Memory", ...promptFormatting.prependBullets(persistentNotes));
  }

  return lines.join("\n");
}

function getCurrentTimeSection(runtimeContext: PromptRuntimeContext) {
  return promptFormatting.buildSection("Current time", [
    `Authoritative local time for this turn: ${runtimeContext.currentDateTime}`,
    `Local time zone: ${runtimeContext.timeZone}`,
    "Resolve words like today, yesterday, tomorrow, now, latest, currently, and recently against this timestamp.",
    "If time wording is ambiguous or the user may be mistaken, state the exact date explicitly."
  ], "Time summary: use this turn's local timestamp as the source of truth for relative-date reasoning.");
}

function getRuntimeEnvironmentSection(runtimeContext: PromptRuntimeContext) {
  return promptFormatting.buildSection("Environment", [
    `Local date: ${runtimeContext.currentDate}`,
    `Local date and time: ${runtimeContext.currentDateTime}`,
    `Time zone: ${runtimeContext.timeZone}`,
    `Platform: ${runtimeContext.platform}`,
    `Workspace root: ${runtimeContext.workspaceRoot}`,
    "Path notation: absolute paths are preferred; ~ and ~/... resolve to the user's home directory.",
    "Path scope: local filesystem paths are available to tools; read/search and file-modifying tools may request user approval for external directories on demand.",
    `Model: ${runtimeContext.model}`
  ], "Environment summary: the following runtime details define the local date, paths, platform, and model for this turn.");
}

function getLanguageSection(options: PromptBuildOptions) {
  if (!options.languagePreference) {
    return null;
  }

  return [
    `Language summary: all user-facing communication should stay in ${options.languagePreference} while code and identifiers remain unchanged.`,
    "",
    "# Language",
    `Always respond in ${options.languagePreference}. Use ${options.languagePreference} for explanations, comments, and user-facing communication. Keep code and identifiers unchanged.`
  ].join("\n");
}

function getToolResultSummaryReminderSection() {
  return [
    "Tool result summary: carry forward important tool facts in your own words instead of relying on raw output alone.",
    "",
    "# Tool result handling",
    "When tool outputs contain important facts for later steps, summarize and carry them forward in your own words."
  ].join("\n");
}

export const DYNAMIC_PROMPT_SECTIONS: PromptSection[] = [
  turnPromptSection("current_time", (runtimeContext) => getCurrentTimeSection(runtimeContext)),
  turnPromptSection("available_skills", (runtimeContext) =>
    getAvailableSkillsSection(runtimeContext)
  ),
  turnPromptSection("memory", (runtimeContext) => getMemorySection(runtimeContext)),
  turnPromptSection("environment", (runtimeContext) => getRuntimeEnvironmentSection(runtimeContext)),
  sessionPromptSection("language", (_runtimeContext, options) => getLanguageSection(options)),
  sessionPromptSection("summarize_tool_results", () => getToolResultSummaryReminderSection())
];
