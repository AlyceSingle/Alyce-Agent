import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateBundledRelativePath } from "./bundled.js";
import { SkillManager } from "./manager.js";

async function runTests() {
  await testBundledSkillsAppearByDefault();
  await testRefreshPicksUpSkillFileChanges();
  testBundledSkillPathValidationRejectsTraversal();
  console.log("skill manager tests passed");
}

async function testBundledSkillsAppearByDefault() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-skill-manager-bundled-"));
  const manager = new SkillManager({
    workspaceRoot,
    userHomeDirectory: path.join(workspaceRoot, "user-home")
  });
  const catalog = await manager.discoverSkills();

  assert.equal(catalog.skills.some((skill) => skill.source === "bundled"), true);
  manager.close();
}

async function testRefreshPicksUpSkillFileChanges() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-skill-manager-refresh-"));
  const skillDirectory = path.join(workspaceRoot, ".alyce", "skills", "review");
  await fs.mkdir(skillDirectory, { recursive: true });
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await fs.writeFile(skillPath, fixtureSkill("review", "First description"), "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, ".alyce", "skills.json"),
    JSON.stringify({ disableBundledSkills: true }, null, 2),
    "utf8"
  );

  const manager = new SkillManager({
    workspaceRoot,
    userHomeDirectory: path.join(workspaceRoot, "user-home")
  });
  const before = await manager.discoverSkills();
  assert.equal(before.skills[0]?.description, "First description");

  await fs.writeFile(skillPath, fixtureSkill("review", "Second description"), "utf8");
  const after = await manager.refresh();
  assert.equal(after.skills[0]?.description, "Second description");
  manager.close();
}

function testBundledSkillPathValidationRejectsTraversal() {
  assert.throws(() => validateBundledRelativePath("../escape.txt"), /Invalid bundled skill relative path/);
}

function fixtureSkill(name: string, description: string) {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `# ${name}`,
    "",
    description
  ].join("\n");
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
