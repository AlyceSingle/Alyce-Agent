import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadStartupContextFromArgs,
  parseStartupContextArgs
} from "./startupContext.js";

async function runTests() {
  testNoStartupArgs();
  testParseStartupArgsRejectsPromptConflict();
  await testContextFileInjectsGeneratedContext();
  await testSelectionFileAndInitialPrompt();
  await testPromptFilePrefillsInitialPrompt();
  await testMissingContextFileHasClearError();
  await testMissingPromptFileHasClearError();
  await testExternalContextFileRespectsAllowedRoots();
  console.log("startupContext tests passed");
}

function testNoStartupArgs() {
  const parsed = parseStartupContextArgs([]);

  assert.deepEqual(parsed, {
    contextFiles: [],
    selectionFiles: []
  });
}

function testParseStartupArgsRejectsPromptConflict() {
  assert.throws(
    () => parseStartupContextArgs([
      "--initial-prompt",
      "hello",
      "--prompt-file",
      "prompt.txt"
    ]),
    /Cannot use --initial-prompt and --prompt-file/
  );
}

async function testContextFileInjectsGeneratedContext() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-startup-context-"));
  const filePath = path.join(workspaceRoot, "src.ts");
  await fs.writeFile(filePath, "const value = 1;\n", "utf8");

  const context = await loadStartupContextFromArgs(["--context-file", filePath], {
    workspaceRoot,
    allowedRoots: [workspaceRoot]
  });

  assert.equal(context.files.length, 1);
  assert.equal(context.contextMessage?.role, "user");
  assert.equal(context.contextMessage?.name, "alyce_startup_context");
  assert.match(String(context.contextMessage?.content), /## Context File/);
  assert.match(String(context.contextMessage?.content), /const value = 1;/);
  assert.match(context.summary ?? "", /Context: src\.ts/);
}

async function testSelectionFileAndInitialPrompt() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-startup-selection-"));
  const selectionPath = path.join(workspaceRoot, ".alyce", "selection.txt");
  await fs.mkdir(path.dirname(selectionPath), { recursive: true });
  await fs.writeFile(selectionPath, "selected text\n", "utf8");

  const context = await loadStartupContextFromArgs([
    "--selection-file",
    selectionPath,
    "--initial-prompt",
    "Review this selection"
  ], {
    workspaceRoot,
    allowedRoots: [workspaceRoot]
  });

  assert.equal(context.initialPrompt, "Review this selection");
  assert.match(String(context.contextMessage?.content), /## Selection File/);
  assert.match(String(context.contextMessage?.content), /selected text/);
  assert.match(context.summary ?? "", /Initial prompt/);
}

async function testPromptFilePrefillsInitialPrompt() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-startup-prompt-"));
  const promptPath = path.join(workspaceRoot, "prompt.txt");
  await fs.writeFile(promptPath, "  Explain this file.  \n", "utf8");

  const context = await loadStartupContextFromArgs(["--prompt-file", promptPath], {
    workspaceRoot,
    allowedRoots: [workspaceRoot]
  });

  assert.equal(context.initialPrompt, "Explain this file.");
  assert.equal(context.contextMessage, undefined);
}

async function testMissingContextFileHasClearError() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-startup-missing-"));
  const missingPath = path.join(workspaceRoot, "missing.ts");

  await assert.rejects(
    () => loadStartupContextFromArgs(["--context-file", missingPath], {
      workspaceRoot,
      allowedRoots: [workspaceRoot]
    }),
    /Startup context file does not exist/
  );
}

async function testMissingPromptFileHasClearError() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-startup-missing-prompt-"));
  const missingPath = path.join(workspaceRoot, "missing-prompt.txt");

  await assert.rejects(
    () => loadStartupContextFromArgs(["--prompt-file", missingPath], {
      workspaceRoot,
      allowedRoots: [workspaceRoot]
    }),
    /Startup prompt file does not exist/
  );
}

async function testExternalContextFileRespectsAllowedRoots() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-startup-root-"));
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-startup-external-"));
  const externalPath = path.join(externalRoot, "external.ts");
  await fs.writeFile(externalPath, "external", "utf8");

  await assert.rejects(
    () => loadStartupContextFromArgs(["--context-file", externalPath], {
      workspaceRoot,
      allowedRoots: [workspaceRoot]
    }),
    /Path is outside the allowed roots/
  );
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
