import assert from "node:assert/strict";
import { execFileNoThrow } from "./execFileNoThrow.js";

async function runTests() {
  await testExecFileNoThrowCapturesSuccessfulOutput();
  await testExecFileNoThrowPreservesOutputOnError();
  await testExecFileNoThrowClearsOutputWhenRequested();
  console.log("execFileNoThrow tests passed");
}

async function testExecFileNoThrowCapturesSuccessfulOutput() {
  const result = await execFileNoThrow(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    {
      input: "clipboard text",
      timeout: 5_000,
      useCwd: false
    }
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "clipboard text");
  assert.equal(result.stderr, "");
}

async function testExecFileNoThrowPreservesOutputOnError() {
  const result = await execFileNoThrow(
    process.execPath,
    ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
    {
      timeout: 5_000,
      useCwd: false
    }
  );

  assert.equal(result.code, 7);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.error, "7");
}

async function testExecFileNoThrowClearsOutputWhenRequested() {
  const result = await execFileNoThrow(
    process.execPath,
    ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
    {
      preserveOutputOnError: false,
      timeout: 5_000,
      useCwd: false
    }
  );

  assert.equal(result.code, 7);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.error, undefined);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
