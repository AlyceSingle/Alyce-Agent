import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runNativeCommandWithTimeout } from "./nativeCommandRunner.js";

async function runTests() {
  await testRunsDirectArgvCommand();
  await testPassesInputToCommand();
  await testInvalidArgvReturnsErrorResult();
  await testSpawnSynchronousErrorReturnsErrorResult();
  await testTimeoutReturnsTimedOutResult();
  await testRunsWindowsCmdFileWithSpaces();
  console.log("nativeCommandRunner tests passed");
}

async function testRunsDirectArgvCommand() {
  const result = await runNativeCommandWithTimeout(
    [process.execPath, "-e", "process.stdout.write('native-ok')"],
    { timeoutMs: 5_000 }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "native-ok");
  assert.equal(result.stderr, "");
}

async function testPassesInputToCommand() {
  const result = await runNativeCommandWithTimeout(
    [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
    { timeoutMs: 5_000, input: "hello native runner" }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello native runner");
}

async function testInvalidArgvReturnsErrorResult() {
  const result = await runNativeCommandWithTimeout([], { timeoutMs: 5_000 });

  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /argv must include a command/);
}

async function testSpawnSynchronousErrorReturnsErrorResult() {
  const result = await runNativeCommandWithTimeout([process.execPath, "--version"], {
    timeoutMs: 5_000,
    cwd: "\0"
  });

  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /null bytes|argument|path/i);
}

async function testTimeoutReturnsTimedOutResult() {
  const result = await runNativeCommandWithTimeout(
    [process.execPath, "-e", "setTimeout(() => undefined, 5000)"],
    { timeoutMs: 50 }
  );

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.timedOut, true);
  assert.equal(result.error, "timeout");
}

async function testRunsWindowsCmdFileWithSpaces() {
  if (process.platform !== "win32") {
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alyce native cmd space "));
  const commandPath = path.join(tempDir, "echo args.cmd");

  try {
    fs.writeFileSync(
      commandPath,
      "@echo off\r\necho cmd-ok:%~1:%~2\r\nexit /b 0\r\n",
      "utf8"
    );

    const result = await runNativeCommandWithTimeout(
      [commandPath, "left arg", "right"],
      { timeoutMs: 5_000 }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "cmd-ok:left arg:right");
    assert.equal(result.stderr, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
