import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectProjectInstructionsContext,
  MAX_PROJECT_INSTRUCTION_CHARS
} from "./projectInstructionsContext.js";

async function runTests() {
  await testReadsAgentsFile();
  await testPrefersAlyceOverAgentsAndClaude();
  await testReturnsUndefinedWhenNoFileExists();
  await testIgnoresEmptyAndDirectoryCandidates();
  await testTruncatesOversizedFile();
  console.log("projectInstructionsContext tests passed");
}

async function testReadsAgentsFile() {
  await withWorkspace(async (workspaceRoot) => {
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Rules\nUse two spaces.\n", "utf8");

    const result = await collectProjectInstructionsContext(workspaceRoot);

    assert.ok(result);
    assert.equal(result.fileName, "AGENTS.md");
    assert.equal(result.content, "# Rules\nUse two spaces.");
    assert.equal(result.truncatedChars, 0);
  });
}

async function testPrefersAlyceOverAgentsAndClaude() {
  await withWorkspace(async (workspaceRoot) => {
    fs.writeFileSync(path.join(workspaceRoot, "CLAUDE.md"), "from claude", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "from agents", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "ALYCE.md"), "from alyce", "utf8");

    const result = await collectProjectInstructionsContext(workspaceRoot);

    assert.equal(result?.fileName, "ALYCE.md");
    assert.equal(result?.content, "from alyce");
  });
}

async function testReturnsUndefinedWhenNoFileExists() {
  await withWorkspace(async (workspaceRoot) => {
    assert.equal(await collectProjectInstructionsContext(workspaceRoot), undefined);
  });
}

// 空文件和同名目录都不应被当作有效约定文件，而要继续探测下一个候选。
async function testIgnoresEmptyAndDirectoryCandidates() {
  await withWorkspace(async (workspaceRoot) => {
    fs.mkdirSync(path.join(workspaceRoot, "ALYCE.md"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "   \n\n  ", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "CLAUDE.md"), "real content", "utf8");

    const result = await collectProjectInstructionsContext(workspaceRoot);

    assert.equal(result?.fileName, "CLAUDE.md");
    assert.equal(result?.content, "real content");
  });
}

async function testTruncatesOversizedFile() {
  await withWorkspace(async (workspaceRoot) => {
    const overflow = 250;
    fs.writeFileSync(
      path.join(workspaceRoot, "AGENTS.md"),
      "x".repeat(MAX_PROJECT_INSTRUCTION_CHARS + overflow),
      "utf8"
    );

    const result = await collectProjectInstructionsContext(workspaceRoot);

    assert.equal(result?.content.length, MAX_PROJECT_INSTRUCTION_CHARS);
    assert.equal(result?.truncatedChars, overflow);
  });
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alyce-project-instructions-"));
  try {
    await run(workspaceRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
