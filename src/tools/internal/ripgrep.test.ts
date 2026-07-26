import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRipgrepMaxOutputBytes, runRipgrep, splitRipgrepLines } from "./ripgrep.js";

const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

async function runTests() {
  testMaxOutputBytesDefaultsWhenUnset();
  testMaxOutputBytesParsesValidValue();
  testMaxOutputBytesRejectsInvalidValues();
  testMaxOutputBytesRejectsSuffixedValues();
  await testRunRipgrepTruncatesOversizedOutput();
  await testRunRipgrepDoesNotFlagSmallOutput();
  console.log("ripgrep tests passed");
}

function testMaxOutputBytesDefaultsWhenUnset() {
  assert.equal(resolveRipgrepMaxOutputBytes({}), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(
    resolveRipgrepMaxOutputBytes({ ALYCE_RIPGREP_MAX_OUTPUT_BYTES: "  " }),
    DEFAULT_MAX_OUTPUT_BYTES
  );
}

function testMaxOutputBytesParsesValidValue() {
  assert.equal(resolveRipgrepMaxOutputBytes({ ALYCE_RIPGREP_MAX_OUTPUT_BYTES: "4096" }), 4096);
}

function testMaxOutputBytesRejectsInvalidValues() {
  assert.equal(
    resolveRipgrepMaxOutputBytes({ ALYCE_RIPGREP_MAX_OUTPUT_BYTES: "not-a-number" }),
    DEFAULT_MAX_OUTPUT_BYTES
  );
  assert.equal(
    resolveRipgrepMaxOutputBytes({ ALYCE_RIPGREP_MAX_OUTPUT_BYTES: "0" }),
    DEFAULT_MAX_OUTPUT_BYTES
  );
  assert.equal(
    resolveRipgrepMaxOutputBytes({ ALYCE_RIPGREP_MAX_OUTPUT_BYTES: "-5" }),
    DEFAULT_MAX_OUTPUT_BYTES
  );
}

// parseInt("20MB") 会得到 20，把上限静默压到 20 字节，必须回落默认值。
function testMaxOutputBytesRejectsSuffixedValues() {
  for (const raw of ["20MB", "20 mb", "1e6", "0x10", "12.5", "20_000"]) {
    assert.equal(
      resolveRipgrepMaxOutputBytes({ ALYCE_RIPGREP_MAX_OUTPUT_BYTES: raw }),
      DEFAULT_MAX_OUTPUT_BYTES,
      `expected ${raw} to fall back to the default`
    );
  }

  assert.equal(resolveRipgrepMaxOutputBytes({ ALYCE_RIPGREP_MAX_OUTPUT_BYTES: " 4096 " }), 4096);
}

async function testRunRipgrepTruncatesOversizedOutput() {
  await withMatchFixture(async (fixtureDir) => {
    await withEnvValue("ALYCE_RIPGREP_MAX_OUTPUT_BYTES", "512", async () => {
      const result = await runRipgrep(["--no-heading", "match-line", "."], fixtureDir, 30_000);

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdoutTruncated, true);
      assert.ok(Buffer.byteLength(result.stdout) <= 512);
    });
  });
}

async function testRunRipgrepDoesNotFlagSmallOutput() {
  await withMatchFixture(async (fixtureDir) => {
    const result = await runRipgrep(["--no-heading", "unique-needle-line", "."], fixtureDir, 30_000);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutTruncated, false);
    assert.equal(splitRipgrepLines(result.stdout).length, 1);
  });
}

async function withMatchFixture(run: (fixtureDir: string) => Promise<void>) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "alyce-ripgrep-test-"));
  try {
    const lines = Array.from({ length: 500 }, (_, index) => `match-line ${index}`);
    lines.push("unique-needle-line");
    fs.writeFileSync(path.join(fixtureDir, "fixture.txt"), lines.join("\n"), "utf8");
    await run(fixtureDir);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function withEnvValue(key: string, value: string, run: () => Promise<void>) {
  const previousValue = process.env[key];
  process.env[key] = value;
  try {
    await run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
