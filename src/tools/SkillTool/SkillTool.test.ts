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
  await testDiscoversSkillWithoutFrontmatterFromProjectRoot();
  await testDiscoversUserSkillFromUserRoot();
  await testProjectOverridesUserSkill();
  await testSampleFilesExcludeSkillFileAndCapAtTen();
  await testUnknownSkillListsAvailableSkills();
  await testExecutionIncludesPluginIdAndDependencyWarnings();
  await testExecutionWarnsWhenMcpToolIsMissing();
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
  assert.equal(metadata.pluginId, undefined);
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

async function testDiscoversSkillWithoutFrontmatterFromProjectRoot() {
  const tempRoot = await createTempRoot();
  const projectRoot = path.join(tempRoot, "project", ".alyce", "skills");
  const skillDirectory = path.join(projectRoot, "plain-skill");
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, "SKILL.md"), [
    "# Plain skill",
    "",
    "First useful sentence.",
    "",
    "More details here."
  ].join("\n"), "utf8");

  const result = await discoverSkills({
    projectRoot,
    userRoot: path.join(tempRoot, "missing-user")
  });
  const skill = result.skills.find((entry) => entry.name === "plain-skill");

  assert.equal(skill?.source, "project");
  assert.equal(skill?.description, "First useful sentence.");
  assert.deepEqual(result.duplicateWarnings, []);
}

async function testDiscoversUserSkillFromUserRoot() {
  const tempRoot = await createTempRoot();
  const projectRoot = path.join(tempRoot, "project", ".alyce", "skills");
  const userRoot = path.join(tempRoot, "user", ".alyce", "skills");
  await writeSkill(path.join(userRoot, "user-only"), "user-only", "User only skill");

  const result = await discoverSkills({ projectRoot, userRoot });
  const skill = result.skills.find((entry) => entry.name === "user-only");

  assert.equal(skill?.source, "user");
  assert.equal(skill?.description, "User only skill");
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

async function testExecutionIncludesPluginIdAndDependencyWarnings() {
  const tempRoot = await createTempRoot();
  const workspaceRoot = path.join(tempRoot, "workspace");
  const skillDirectory = path.join(workspaceRoot, ".alyce", "skills", "known");
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, "SKILL.md"), [
    "---",
    "name: known",
    "description: Known skill",
    "plugin_id: plugins.example.known",
    "mcp_servers:",
    "  - github",
    "---",
    "# known",
    "",
    "Follow the local workflow."
  ].join("\n"), "utf8");

  const result = await executeSkillTool(
    { name: "known" },
    createTestContext(workspaceRoot, {
      mcpRuntime: createMcpRuntime({
        getStatus: async () => ({ servers: [] })
      })
    })
  );

  assert.equal(isToolResultEnvelope(result), true);
  const payload = isToolResultEnvelope(result)
    ? result.result as { pluginId?: string; dependencyWarnings: string[] }
    : null;
  assert.equal(payload?.pluginId, "plugins.example.known");
  assert.equal(payload?.dependencyWarnings[0]?.includes("requires MCP server 'github'"), true);
}

async function testExecutionWarnsWhenMcpToolIsMissing() {
  const tempRoot = await createTempRoot();
  const workspaceRoot = path.join(tempRoot, "workspace");
  const skillDirectory = path.join(workspaceRoot, ".alyce", "skills", "deploy");
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, "SKILL.md"), [
    "---",
    "name: deploy",
    "description: Deploy skill",
    "mcp_tools:",
    "  - github.deploy",
    "---",
    "# deploy",
    "",
    "Follow the deploy workflow."
  ].join("\n"), "utf8");

  const result = await executeSkillTool(
    { name: "deploy" },
    createTestContext(workspaceRoot, {
      mcpRuntime: createMcpRuntime({
        getStatus: async () => ({
          servers: [{
            name: "github",
            scope: "project",
            enabled: true,
            required: false,
            status: "connected",
            transport: "stdio",
            endpoint: "npx github-mcp",
            capabilities: {
              tools: true,
              resources: false,
              prompts: false
            },
            toolCount: 1,
            directToolCount: 1,
            hiddenToolCount: 0,
            toolExposure: "direct"
          }]
        }),
        listTools: async () => ({
          servers: [{
            server: "github",
            status: "completed",
            tools: [{
              server: "github",
              name: "issues",
              exposedName: "mcp__github__issues",
              description: "List issues."
            }]
          }],
          toolCount: 1
        })
      })
    })
  );

  assert.equal(isToolResultEnvelope(result), true);
  const payload = isToolResultEnvelope(result)
    ? result.result as { dependencyWarnings: string[] }
    : null;
  assert.equal(payload?.dependencyWarnings[0]?.includes("does not expose 'deploy'"), true);
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

function createMcpRuntime(
  patch: Partial<ToolExecutionContext["mcpRuntime"]> = {}
): NonNullable<ToolExecutionContext["mcpRuntime"]> {
  return {
    getToolSchemas: async () => [],
    canExecuteTool: () => false,
    executeNamedToolCall: async () => undefined,
    executeToolCall: async () => undefined,
    getStatus: async () => ({ servers: [] }),
    listTools: async () => ({ servers: [], toolCount: 0 }),
    listResources: async () => ({ servers: [], resourceCount: 0 }),
    listPrompts: async () => ({ servers: [], promptCount: 0 }),
    getPrompt: async (serverName: string, promptName: string) => ({
      status: "not_found" as const,
      server: serverName,
      name: promptName,
      messages: [],
      error: "not found"
    }),
    listResourceTemplates: async () => ({ servers: [], resourceTemplateCount: 0 }),
    readResource: async (server: string, uri: string) => ({
      status: "not_found" as const,
      server,
      uri,
      contents: []
    }),
    reloadConfig: async () => undefined,
    addServer: async () => {
      throw new Error("not implemented");
    },
    removeServer: async () => {
      throw new Error("not implemented");
    },
    setServerEnabled: async () => {
      throw new Error("not implemented");
    },
    loginServer: async (serverName: string) => ({
      status: "completed" as const,
      server: serverName,
      message: "Logged in."
    }),
    setInteractionHandlers: () => undefined,
    close: async () => undefined,
    ...patch
  };
}

void runTests();
