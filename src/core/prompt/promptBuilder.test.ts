import assert from "node:assert/strict";
import { buildDefaultSystemPrompt, buildEffectiveSystemPrompt } from "./builder.js";
import { PromptSectionResolver } from "./sectionResolver.js";
import type { PromptRuntimeContext } from "./types.js";
import type { SkillPromptContext } from "../../skills/service.js";

function runTests() {
  void Promise.all([
    testDefaultSystemPromptStartsWithSummaryLine(),
    testToolListUpdatesAcrossBuilds(),
    testDefaultSystemPromptShowsAvailableSkills(),
    testDefaultSystemPromptShowsOptionalSectionSummaries(),
    testDefaultSystemPromptGuidesLongRunningServers(),
    testDefaultSystemPromptGuidesInteractivePtyUse(),
    testEffectiveSystemPromptSummarizesAdditionalInstructions(),
    testDefaultSystemPromptUsesEnglishAuthoredText()
  ]).then(() => {
    console.log("promptBuilder tests passed");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function createRuntimeContext(
  availableTools: string[],
  availableSkills?: SkillPromptContext
): PromptRuntimeContext {
  return {
    model: "test-model",
    workspaceRoot: process.cwd(),
    allowedRoots: [process.cwd()],
    currentDate: "2026-05-07",
    currentDateTime: "2026-05-07 12:00:00",
    timeZone: "Asia/Shanghai",
    platform: process.platform,
    availableTools,
    ...(availableSkills ? { availableSkills } : {}),
    memory: {
      sessionNotes: [],
      persistentNotes: []
    }
  };
}

async function testDefaultSystemPromptStartsWithSummaryLine() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read"]),
    {},
    new PromptSectionResolver()
  );

  const firstNonEmptyLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0);
  assert.equal(firstNonEmptyLine, 'Identity summary: you are "Alyce", the interactive terminal assistant responsible for helping the user complete practical tasks.');
  assert.match(prompt, /System summary:/);
  assert.match(prompt, /Time summary:/);
  assert.match(prompt, /Tool result summary:/);
}

async function testDefaultSystemPromptUsesEnglishAuthoredText() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read", "Grep", "PowerShell"]),
    {},
    new PromptSectionResolver()
  );

  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/);
}

async function testDefaultSystemPromptGuidesLongRunningServers() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["Bash", "PowerShell"]),
    {},
    new PromptSectionResolver()
  );

  assert.match(prompt, /local development server/);
  assert.match(prompt, /background process tool/);
  assert.match(prompt, /npm run dev/);
  assert.match(prompt, /foreground Bash or PowerShell/);
}

async function testDefaultSystemPromptGuidesInteractivePtyUse() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["Bash", "PowerShell", "PtyCreate", "PtyRead", "PtyWrite"]),
    {},
    new PromptSectionResolver()
  );

  assert.match(prompt, /Use PtyCreate/);
  assert.match(prompt, /interactive terminal programs/);
  assert.match(prompt, /ordinary one-shot commands/);
}

async function testToolListUpdatesAcrossBuilds() {
  const resolver = new PromptSectionResolver();

  const first = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read"]),
    {},
    resolver
  );
  const second = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read", "mcp__demo__echo"]),
    {},
    resolver
  );

  assert.match(first, /Current available tools: Read/);
  assert.doesNotMatch(first, /mcp__demo__echo/);
  assert.match(second, /Current available tools: Read, mcp__demo__echo/);
  assert.match(second, /Use MCP tools/);
}

async function testDefaultSystemPromptShowsAvailableSkills() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["SkillTool"], {
      skills: [
        {
          name: "code-review",
          source: "project",
          description: "Review code changes.",
          shortDescription: "Review code changes.",
          whenToUse: "Use when the user asks for a review."
        }
      ],
      totalCount: 1,
      truncatedCount: 0,
      duplicateWarnings: [],
      charBudget: 8_000
    }),
    {},
    new PromptSectionResolver()
  );

  assert.match(prompt, /Skills summary:/);
  assert.match(prompt, /# Available skills/);
  assert.match(prompt, /\$<skill-name>/);
  assert.match(prompt, /code-review \[project\]/);
  assert.match(prompt, /Use when the user asks for a review/);
}

async function testDefaultSystemPromptShowsOptionalSectionSummaries() {
  const prompt = await buildDefaultSystemPrompt(
    {
      ...createRuntimeContext(["SkillTool"]),
      memory: {
        sessionSummary: "Branch: feature/system-summary",
        sessionNotes: ["Check the first line before expanding prompts."],
        persistentNotes: ["The user prefers concise implementation notes."]
      }
    },
    {
      personaPreset: "alyce",
      languagePreference: "Simplified Chinese"
    },
    new PromptSectionResolver()
  );

  assert.match(prompt, /Persona preset summary:/);
  assert.match(prompt, /Memory summary:/);
  assert.match(prompt, /Language summary:/);
}

async function testEffectiveSystemPromptSummarizesAdditionalInstructions() {
  const prompt = await buildEffectiveSystemPrompt(
    createRuntimeContext(["Read"]),
    {
      appendSystemPrompt: "# Extra Constraints\nFollow the extra rules."
    },
    new PromptSectionResolver()
  );

  assert.match(prompt, /Additional instructions summary:/);
  assert.match(prompt, /# Additional Instructions/);
  assert.match(prompt, /# Extra Constraints/);
}

runTests();
