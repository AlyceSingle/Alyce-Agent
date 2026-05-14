import assert from "node:assert/strict";
import { resolveSimplePackageManagerFastPath } from "./packageManagerFastPath.js";

function runTests() {
  testAllowsSimplePackageManagerCommandsOnWindows();
  testAllowsQuotedArguments();
  testRejectsNonWindowsCommands();
  testRejectsNonPackageManagerCommands();
  testRejectsComplexShellSyntax();
  testRejectsVariableAndExpansionSyntax();
  testRejectsExplicitPathsAndUnclosedQuotes();
  console.log("packageManagerFastPath tests passed");
}

function testAllowsSimplePackageManagerCommandsOnWindows() {
  assert.deepEqual(resolveSimplePackageManagerFastPath("npm run build", "win32"), [
    "npm",
    "run",
    "build"
  ]);
  assert.deepEqual(resolveSimplePackageManagerFastPath("pnpm.cmd test", "win32"), [
    "pnpm.cmd",
    "test"
  ]);
  assert.deepEqual(resolveSimplePackageManagerFastPath("corepack.exe pnpm --version", "win32"), [
    "corepack.exe",
    "pnpm",
    "--version"
  ]);
  assert.deepEqual(resolveSimplePackageManagerFastPath("bun install", "win32"), [
    "bun",
    "install"
  ]);
}

function testAllowsQuotedArguments() {
  assert.deepEqual(resolveSimplePackageManagerFastPath("npm run \"build app\"", "win32"), [
    "npm",
    "run",
    "build app"
  ]);
  assert.deepEqual(resolveSimplePackageManagerFastPath("yarn add 'left-pad'", "win32"), [
    "yarn",
    "add",
    "left-pad"
  ]);
  assert.deepEqual(resolveSimplePackageManagerFastPath("npm run \"\"", "win32"), [
    "npm",
    "run",
    ""
  ]);
}

function testRejectsNonWindowsCommands() {
  assert.equal(resolveSimplePackageManagerFastPath("npm run build", "linux"), null);
}

function testRejectsNonPackageManagerCommands() {
  assert.equal(resolveSimplePackageManagerFastPath("node script.js", "win32"), null);
  assert.equal(resolveSimplePackageManagerFastPath("git status", "win32"), null);
}

function testRejectsComplexShellSyntax() {
  for (const command of [
    "npm run build; npm test",
    "npm run build && npm test",
    "npm run build > out.txt",
    "Get-ChildItem | npm exec eslint",
    "npm run build || npm test",
    "npm run (build)"
  ]) {
    assert.equal(resolveSimplePackageManagerFastPath(command, "win32"), null, command);
  }
}

function testRejectsVariableAndExpansionSyntax() {
  for (const command of [
    "npm run $script",
    "npm run `\"build`\"",
    "npm install react@^18",
    "npm install %PACKAGE_NAME%",
    "npm --% run build",
    "npm test # comment",
    "npm install left\0right"
  ]) {
    assert.equal(resolveSimplePackageManagerFastPath(command, "win32"), null, command);
  }
}

function testRejectsExplicitPathsAndUnclosedQuotes() {
  assert.equal(resolveSimplePackageManagerFastPath(".\\node_modules\\.bin\\npm.cmd test", "win32"), null);
  assert.equal(resolveSimplePackageManagerFastPath("C:\\nodejs\\npm.cmd test", "win32"), null);
  assert.equal(resolveSimplePackageManagerFastPath("npm run \"build", "win32"), null);
}

runTests();
