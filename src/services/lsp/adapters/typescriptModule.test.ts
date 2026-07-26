import assert from "node:assert/strict";
import path from "node:path";
import {
  describeTypeScriptResolution,
  loadTypeScriptModule,
  MIN_SUPPORTED_TYPESCRIPT_VERSION,
  resetTypeScriptModuleCacheForTests
} from "./typescriptModule.js";

function runTests() {
  testResolutionFindsWorkspaceTypeScript();
  testResolutionFallsBackToBundledForUnknownWorkspace();
  testLoadReturnsUsableModule();
  testLoadIsCachedUntilReset();
  console.log("typescriptModule tests passed");
}

function testResolutionFindsWorkspaceTypeScript() {
  // This repository has typescript installed, so workspace resolution wins.
  const resolution = describeTypeScriptResolution(process.cwd());
  assert.ok(resolution, "expected typescript to resolve in this workspace");
  assert.equal(resolution.source, "workspace");
  assert.equal(resolution.supported, true);
  assert.ok(resolution.version);
  assert.ok(resolution.modulePath.length > 0);
}

function testResolutionFallsBackToBundledForUnknownWorkspace() {
  const nonProjectDirectory = path.parse(process.cwd()).root;
  const resolution = describeTypeScriptResolution(nonProjectDirectory);
  assert.ok(resolution, "expected the bundled typescript fallback to resolve");
  assert.equal(resolution.supported, true);
}

function testLoadReturnsUsableModule() {
  resetTypeScriptModuleCacheForTests();
  const loaded = loadTypeScriptModule(process.cwd());
  assert.ok(loaded, "expected typescript to load in this workspace");
  assert.equal(typeof loaded.module.version, "string");
  assert.equal(typeof loaded.module.createLanguageService, "function");
  assert.ok(loaded.version);
  resetTypeScriptModuleCacheForTests();
}

function testLoadIsCachedUntilReset() {
  resetTypeScriptModuleCacheForTests();
  const first = loadTypeScriptModule(process.cwd());
  const second = loadTypeScriptModule(process.cwd());
  assert.equal(first, second);
  resetTypeScriptModuleCacheForTests();
}

assert.ok(MIN_SUPPORTED_TYPESCRIPT_VERSION.startsWith("5."));
runTests();
