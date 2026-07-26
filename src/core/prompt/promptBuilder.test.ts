import assert from "node:assert/strict";
import { buildDefaultSystemPrompt, buildEffectiveSystemPrompt } from "./builder.js";
import { PromptSectionResolver } from "./sectionResolver.js";
import type { PromptRuntimeContext } from "./types.js";
import type { SkillPromptContext } from "../../skills/service.js";

function runTests() {
  void Promise.all([
    testDefaultSystemPromptStartsWithIdentitySection(),
    testDefaultSystemPromptHasNoSectionSummaryPreambles(),
    testToolListUpdatesAcrossBuilds(),
    testDefaultSystemPromptShowsAvailableSkills(),
    testDefaultSystemPromptShowsOptionalSections(),
    testDefaultSystemPromptGuidesLongRunningServers(),
    testDefaultSystemPromptGuidesInteractivePtyUse(),
    testGitWorkflowSectionFollowsShellAvailability(),
    testEffectiveSystemPromptAppendsAdditionalInstructions(),
    testDefaultSystemPromptUsesEnglishAuthoredText(),
    testGitStatusSectionRendersWhenSnapshotPresent()
  ]).then(() => {
    console.log("promptBuilder tests passed");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function testGitStatusSectionRendersWhenSnapshotPresent() {
  const withGit = await buildDefaultSystemPrompt(
    {
      ...createRuntimeContext(["Read"]),
      gitStatus: {
        branch: "feature/login",
        statusShort: " M src/app.ts",
        recentCommits: "abc1234 Fix login flow",
        truncatedStatusLines: 0
      }
    },
    {},
    new PromptSectionResolver()
  );
  assert.match(withGit, /^# Git repository$/m);
  assert.match(withGit, /Current branch: feature\/login/);
  assert.match(withGit, /M src\/app\.ts/);
  assert.match(withGit, /abc1234 Fix login flow/);

  const withoutGit = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read"]),
    {},
    new PromptSectionResolver()
  );
  assert.doesNotMatch(withoutGit, /^# Git repository$/m);
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

async function testDefaultSystemPromptStartsWithIdentitySection() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read"]),
    {},
    new PromptSectionResolver()
  );

  const firstNonEmptyLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0);
  assert.equal(firstNonEmptyLine, "# Identity");
  assert.match(prompt, /You are "Alyce", an interactive terminal assistant/);
  assert.match(prompt, /^# System$/m);
  assert.match(prompt, /^# Current time$/m);
  assert.match(prompt, /^# Tool result handling$/m);
}

// 段落一律以 # 标题开头，不再重复一行 summary 前缀。
async function testDefaultSystemPromptHasNoSectionSummaryPreambles() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read", "SkillTool"]),
    { personaPreset: "alyce", languagePreference: "Simplified Chinese" },
    new PromptSectionResolver()
  );

  assert.doesNotMatch(prompt, /^[A-Z][A-Za-z ]* summary:/m);
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

// git 需要 shell，没有 shell 工具时这一段不应出现。
async function testGitWorkflowSectionFollowsShellAvailability() {
  const withShell = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read", "Bash"]),
    {},
    new PromptSectionResolver()
  );

  assert.match(withShell, /^# Git workflow$/m);
  assert.match(withShell, /Commit or push only when the user asks/);
  assert.match(withShell, /git add -A/);

  const withoutShell = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read"]),
    {},
    new PromptSectionResolver()
  );

  assert.doesNotMatch(withoutShell, /^# Git workflow$/m);
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

  assert.match(prompt, /^# Available skills$/m);
  assert.match(prompt, /\$<skill-name>/);
  assert.match(prompt, /code-review \[project\]/);
  assert.match(prompt, /Use when the user asks for a review/);
}

async function testDefaultSystemPromptShowsOptionalSections() {
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

  assert.match(prompt, /^# Persona Preset$/m);
  assert.match(prompt, /^# Memory$/m);
  assert.match(prompt, /^# Language$/m);
  assert.match(prompt, /Branch: feature\/system-summary/);
  assert.match(prompt, /Always respond in Simplified Chinese/);
}

async function testEffectiveSystemPromptAppendsAdditionalInstructions() {
  const prompt = await buildEffectiveSystemPrompt(
    createRuntimeContext(["Read"]),
    {
      appendSystemPrompt: "# Extra Constraints\nFollow the extra rules."
    },
    new PromptSectionResolver()
  );

  assert.match(prompt, /# Additional Instructions/);
  assert.match(prompt, /# Extra Constraints/);
  assert.match(prompt, /Follow the extra rules\./);
}

runTests();
