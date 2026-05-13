import assert from "node:assert/strict";
import { buildDefaultSystemPrompt } from "./builder.js";
import { PromptSectionResolver } from "./sectionResolver.js";
import type { PromptRuntimeContext } from "./types.js";

function runTests() {
  void Promise.all([
    testToolListUpdatesAcrossBuilds(),
    testDefaultSystemPromptUsesEnglishAuthoredText()
  ]).then(() => {
    console.log("promptBuilder tests passed");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function createRuntimeContext(availableTools: string[]): PromptRuntimeContext {
  return {
    model: "test-model",
    workspaceRoot: process.cwd(),
    allowedRoots: [process.cwd()],
    currentDate: "2026-05-07",
    currentDateTime: "2026-05-07 12:00:00",
    timeZone: "Asia/Shanghai",
    platform: process.platform,
    availableTools,
    memory: {
      sessionNotes: [],
      persistentNotes: []
    }
  };
}

async function testDefaultSystemPromptUsesEnglishAuthoredText() {
  const prompt = await buildDefaultSystemPrompt(
    createRuntimeContext(["Read", "Grep", "PowerShell"]),
    {},
    new PromptSectionResolver()
  );

  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/);
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

runTests();
