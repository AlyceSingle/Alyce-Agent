import assert from "node:assert/strict";
import fs from "node:fs";
import {
  detectRipgrepInvocation,
  resetRipgrepInvocationCacheForTests,
  resolveBundledRgScript,
  resolveRipgrepInvocation
} from "./resolveRipgrep.js";

async function runTests() {
  await testPrefersSystemRgWhenProbeSucceeds();
  await testFallsBackToBundledScriptWhenSystemRgIsMissing();
  await testKeepsPlainRgWhenNothingIsAvailable();
  testBundledScriptResolvesToExistingFile();
  testInvocationIsCachedUntilReset();
  console.log("resolveRipgrep tests passed");
}

async function testPrefersSystemRgWhenProbeSucceeds() {
  const invocation = await detectRipgrepInvocation({
    probeSystemRg: async () => true,
    resolveBundledScript: () => {
      throw new Error("bundled resolution must not run when system rg exists");
    }
  });

  assert.equal(invocation.kind, "system");
  assert.deepEqual(invocation.argvPrefix, ["rg"]);
}

async function testFallsBackToBundledScriptWhenSystemRgIsMissing() {
  const invocation = await detectRipgrepInvocation({
    probeSystemRg: async () => false,
    resolveBundledScript: () => "/fake/node_modules/ripgrep/lib/rg.mjs",
    execPath: "/fake/bin/node"
  });

  assert.equal(invocation.kind, "bundled");
  assert.deepEqual(invocation.argvPrefix, ["/fake/bin/node", "/fake/node_modules/ripgrep/lib/rg.mjs"]);
}

async function testKeepsPlainRgWhenNothingIsAvailable() {
  const invocation = await detectRipgrepInvocation({
    probeSystemRg: async () => false,
    resolveBundledScript: () => null
  });

  assert.equal(invocation.kind, "system");
  assert.deepEqual(invocation.argvPrefix, ["rg"]);
}

function testBundledScriptResolvesToExistingFile() {
  const bundledScript = resolveBundledRgScript();
  assert.ok(bundledScript, "the ripgrep dependency should be resolvable in this workspace");
  assert.ok(bundledScript.endsWith("rg.mjs"));
  assert.ok(fs.existsSync(bundledScript), `expected bundled rg script to exist at ${bundledScript}`);
}

function testInvocationIsCachedUntilReset() {
  resetRipgrepInvocationCacheForTests();
  const first = resolveRipgrepInvocation();
  const second = resolveRipgrepInvocation();
  assert.equal(first, second);

  resetRipgrepInvocationCacheForTests();
  const third = resolveRipgrepInvocation();
  assert.notEqual(first, third);
  resetRipgrepInvocationCacheForTests();
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
