import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isToolResultEnvelope } from "../resultEnvelope.js";
import type { ToolExecutionContext } from "../types.js";
import {
  discoverSkills,
  executeSkillTool,
  formatSkillContentMessage,
  parseSkillMarkdown
} from "./SkillTool.js";

async function runTests() {
  await testParsesFrontmatter();
  await testFallsBackToDirectoryName();
  await testProjectOverridesUserSkill();
  await testSampleFilesExcludeSkillFileAndCapAtTen();
  await testUnknownSkillListsAvailableSkills();
  await testSuccessfulExecutionReturnsSupplementalMessage();
  console.log("SkillTool tests passed");
}

function createTestContext(
  workspaceRoot: string,
  patch: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  const abortController = new AbortController();
  return {
    workspaceRoot,
    allowedRoots: [workspaceRoot],
    requestApproval: async () => true,
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined,
    ...patch
  };
}

async function testParsesFrontmatter() {
  const metadata = parseSkillMarkdown([
    "---",
    "name: Local Skill",
    "description: Use this workflow.",
    "---",
    "# Body"
  ].join("\n"), path.join("tmp", "fallback"));

  assert.equal(metadata.name, "Local Skill");
  assert.equal(metadata.description, "Use this workflow.");
}

async function testFallsBackToDirectoryName() {
  const metadata = parseSkillMarkdown([
    "# fallback-skill",
    "",
    "First useful sentence."
  ].join("\n"), path.join("tmp", "fallback-skill"));

  assert.equal(metadata.name, "fallback-skill");
  assert.equal(metadata.description, "First useful sentence.");
}

async function testProjectOverridesUserSkill() {
  const tempRoot = await createTempRoot();
  const projectRoot = path.join(tempRoot, "project", ".alyce", "skills");
  const userRoot = path.join(tempRoot, "user", ".alyce", "skills");
  await writeSkill(path.join(userRoot, "shared"), "shared", "User skill");
  await writeSkill(path.join(projectRoot, "shared"), "shared", "Project skill");

  const result = await discoverSkills({ projectRoot, userRoot });
  const shared = result.skills.find((skill) => skill.name === "shared");

  assert.equal(shared?.source, "project");
  assert.equal(shared?.description, "Project skill");
  assert.equal(shared?.duplicatePaths.length, 1);
  assert.equal(result.duplicateWarnings.length, 1);
}

async function testSampleFilesExcludeSkillFileAndCapAtTen() {
  const tempRoot = await createTempRoot();
  const projectRoot = path.join(tempRoot, "project", ".alyce", "skills");
  const skillRoot = path.join(projectRoot, "sampled");
  await writeSkill(skillRoot, "sampled", "Sampled skill");
  for (let index = 0; index < 12; index += 1) {
    await fs.writeFile(path.join(skillRoot, `file-${index}.txt`), String(index), "utf8");
  }

  const result = await discoverSkills({
    projectRoot,
    userRoot: path.join(tempRoot, "missing-user")
  });

  assert.equal(result.skills[0]?.sampleFiles.length, 10);
  assert.equal(result.skills[0]?.sampleFiles.includes("SKILL.md"), false);
}

async function testUnknownSkillListsAvailableSkills() {
  const tempRoot = await createTempRoot();
  const workspaceRoot = path.join(tempRoot, "workspace");
  await writeSkill(path.join(workspaceRoot, ".alyce", "skills", "known"), "known", "Known skill");

  const result = await executeSkillTool(
    { name: "missing" },
    createTestContext(workspaceRoot)
  ) as {
    status: string;
    availableSkills: Array<{ name: string }>;
  };

  assert.equal(result.status, "error");
  assert.equal(result.availableSkills.some((skill) => skill.name === "known"), true);
}

async function testSuccessfulExecutionReturnsSupplementalMessage() {
  const tempRoot = await createTempRoot();
  const workspaceRoot = path.join(tempRoot, "workspace");
  await writeSkill(path.join(workspaceRoot, ".alyce", "skills", "known"), "known", "Known skill");

  const result = await executeSkillTool(
    { name: "known" },
    createTestContext(workspaceRoot)
  );

  assert.equal(isToolResultEnvelope(result), true);
  assert.equal(isToolResultEnvelope(result) ? result.supplementalMessages?.length : 0, 1);
  const message = isToolResultEnvelope(result) ? result.supplementalMessages?.[0] : undefined;
  assert.equal(message?.role, "user");
  assert.equal(message?.name, "alyce_skill_context");
  assert.match(String(message?.content), /<skill_content name="known">/);
}

function formatFixtureSkill(name: string, description: string) {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `# ${name}`,
    "",
    "Follow the local workflow."
  ].join("\n");
}

async function writeSkill(directoryPath: string, name: string, description: string) {
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(
    path.join(directoryPath, "SKILL.md"),
    formatFixtureSkill(name, description),
    "utf8"
  );
}

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "alyce-skill-tool-"));
}

const sampleMessage = formatSkillContentMessage({
  name: "example",
  description: "",
  content: "# Example",
  baseDirectory: "base",
  skillFilePath: "base/SKILL.md",
  sampleFiles: ["assets/template.md"]
});
assert.match(sampleMessage, /Relative paths in this skill are relative to this base directory/);

void runTests();
