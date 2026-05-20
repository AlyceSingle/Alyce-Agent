import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SkillService,
  extractSkillMentions,
  parseSkillMarkdown
} from "./service.js";

async function runTests() {
  testParsesRichFrontmatterFields();
  await testBuildPromptContextTruncatesWithinBudget();
  await testResolveMentionedSkillsLoadsKnownNames();
  await testDisabledSkillConfigHidesMentionedSkill();
  await testActivationPathsBoostMatchingSkills();
  testExtractSkillMentionsDeduplicatesNames();
  console.log("skill service tests passed");
}

function testParsesRichFrontmatterFields() {
  const metadata = parseSkillMarkdown([
    "---",
    "name: code-review",
    "description: Review code changes.",
    "short_description: Review workflow.",
    "when_to_use: Use when the user asks for a review.",
    "version: 1.0.0",
    "plugin_id: plugins.review",
    "allowed_tools:",
    "  - Read",
    "  - Edit",
    "paths:",
    "  - src/reviews/**",
    "mcp_servers:",
    "  - github",
    "mcp_tools:",
    "  - github.review_pull_request",
    "user_invocable: true",
    "---",
    "# Body"
  ].join("\n"), path.join("tmp", "code-review"));

  assert.equal(metadata.name, "code-review");
  assert.equal(metadata.description, "Review code changes.");
  assert.equal(metadata.shortDescription, "Review workflow.");
  assert.equal(metadata.whenToUse, "Use when the user asks for a review.");
  assert.equal(metadata.version, "1.0.0");
  assert.equal(metadata.pluginId, "plugins.review");
  assert.deepEqual(metadata.allowedTools, ["Read", "Edit"]);
  assert.deepEqual(metadata.activationPaths, ["src/reviews/**"]);
  assert.deepEqual(metadata.dependencies, [
    { type: "mcp_server", name: "github" },
    { type: "mcp_tool", name: "github.review_pull_request" }
  ]);
  assert.equal(metadata.userInvocable, true);
}

async function testBuildPromptContextTruncatesWithinBudget() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-skill-service-prompt-"));
  await writeSkill(
    path.join(workspaceRoot, ".alyce", "skills", "alpha"),
    "alpha",
    "Alpha description",
    "Use alpha when needed."
  );
  await writeSkill(
    path.join(workspaceRoot, ".alyce", "skills", "beta"),
    "beta",
    "Beta description",
    "Use beta when needed."
  );
  await writeSkillConfig(workspaceRoot, {
    disableBundledSkills: true
  });

  const service = new SkillService({
    workspaceRoot,
    userHomeDirectory: path.join(workspaceRoot, "user-home"),
    promptCharBudget: 70
  });
  const context = await service.buildPromptContext();

  assert.equal(context.totalCount, 2);
  assert.equal(context.skills.length, 1);
  assert.equal(context.truncatedCount, 1);
}

async function testResolveMentionedSkillsLoadsKnownNames() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-skill-service-mentions-"));
  await writeSkill(
    path.join(workspaceRoot, ".alyce", "skills", "code-review"),
    "code-review",
    "Review code changes.",
    "Use when asked for review."
  );
  await writeSkillConfig(workspaceRoot, {
    disableBundledSkills: true
  });

  const service = new SkillService({
    workspaceRoot,
    userHomeDirectory: path.join(workspaceRoot, "user-home")
  });
  const resolution = await service.resolveMentionedSkills(
    "Please use $code-review and ignore $HOME and $missing-skill."
  );

  assert.deepEqual(resolution.mentions, ["code-review", "HOME", "missing-skill"]);
  assert.deepEqual(resolution.resolvedSkills.map((skill) => skill.name), ["code-review"]);
  assert.deepEqual(resolution.unresolvedMentions, ["HOME", "missing-skill"]);
  assert.deepEqual(resolution.disabledMentions, []);
}

async function testDisabledSkillConfigHidesMentionedSkill() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-skill-service-disabled-"));
  await writeSkill(
    path.join(workspaceRoot, ".alyce", "skills", "code-review"),
    "code-review",
    "Review code changes.",
    "Use when asked for review."
  );
  await writeSkillConfig(workspaceRoot, {
    disabledSkillNames: ["code-review"],
    disableBundledSkills: true
  });

  const service = new SkillService({
    workspaceRoot,
    userHomeDirectory: path.join(workspaceRoot, "user-home")
  });
  const catalog = await service.discoverSkills();
  const resolution = await service.resolveMentionedSkills("Please use $code-review.");

  assert.equal(catalog.skills.some((skill) => skill.name === "code-review"), false);
  assert.equal(catalog.disabledSkills.some((skill) => skill.name === "code-review"), true);
  assert.deepEqual(resolution.disabledMentions, ["code-review"]);
}

async function testActivationPathsBoostMatchingSkills() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-skill-service-activation-"));
  await writeSkill(
    path.join(workspaceRoot, ".alyce", "skills", "payments"),
    "payments",
    "Payments skill",
    "Use on payments changes.",
    {
      paths: ["src/payments/**"]
    }
  );
  await writeSkill(
    path.join(workspaceRoot, ".alyce", "skills", "generic"),
    "generic",
    "Generic skill",
    "Use anywhere."
  );
  await writeSkillConfig(workspaceRoot, {
    disableBundledSkills: true
  });

  const service = new SkillService({
    workspaceRoot,
    userHomeDirectory: path.join(workspaceRoot, "user-home")
  });
  const context = await service.buildPromptContext({
    activationContext: {
      workspaceRoot,
      referencedPaths: ["src/payments/refund.ts"],
      openedPaths: []
    }
  });

  assert.equal(context.skills[0]?.name, "payments");
}

function testExtractSkillMentionsDeduplicatesNames() {
  assert.deepEqual(
    extractSkillMentions("Use $code-review then $code-review again."),
    ["code-review"]
  );
}

async function writeSkill(
  directoryPath: string,
  name: string,
  description: string,
  whenToUse: string,
  options: {
    paths?: string[];
  } = {}
) {
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(
    path.join(directoryPath, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      `when_to_use: ${whenToUse}`,
      ...(options.paths
        ? [
            "paths:",
            ...options.paths.map((entry) => `  - ${entry}`)
          ]
        : []),
      "---",
      `# ${name}`,
      "",
      description
    ].join("\n"),
    "utf8"
  );
}

async function writeSkillConfig(
  workspaceRoot: string,
  config: {
    disabledSkillNames?: string[];
    disableBundledSkills?: boolean;
  }
) {
  await fs.mkdir(path.join(workspaceRoot, ".alyce"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".alyce", "skills.json"),
    JSON.stringify(config, null, 2),
    "utf8"
  );
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
