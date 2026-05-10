import assert from "node:assert/strict";
import { __SESSION_CONTROLLER_TESTING__ } from "./sessionController.js";

async function runTests() {
  testMergeThinkingContentSkipsWhitespaceChunk();
  testMergeThinkingContentAcceptsInitialChunk();
  testMergeThinkingContentPrefersCumulativeSnapshot();
  testMergeThinkingContentAppendsDeltaChunkWithoutLosingWhitespace();
  testMergeThinkingContentAvoidsDuplicateTailDelta();
  testMergeThinkingContentAppendsOnlyNonOverlappingSuffix();
  testExtractThinkingDeltaForInitialSnapshot();
  testExtractThinkingDeltaForSuffixGrowth();
  testExtractThinkingDeltaForUnchangedSnapshot();
  testExtractThinkingDeltaForOverlap();
  await testWaitForUiPaintYieldsToMacrotask();
  console.log("sessionController tests passed");
}

function testMergeThinkingContentSkipsWhitespaceChunk() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", "   ");
  assert.equal(merged, "hello");
}

function testMergeThinkingContentAcceptsInitialChunk() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("", "hello");
  assert.equal(merged, "hello");
}

function testMergeThinkingContentPrefersCumulativeSnapshot() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", "hello world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAppendsDeltaChunkWithoutLosingWhitespace() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", " world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAvoidsDuplicateTailDelta() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello world", " world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAppendsOnlyNonOverlappingSuffix() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent(
    "The quick brown f",
    "fox jumps"
  );
  assert.equal(merged, "The quick brown fox jumps");
}

function testExtractThinkingDeltaForInitialSnapshot() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("", "hello");
  assert.equal(delta, "hello");
}

function testExtractThinkingDeltaForSuffixGrowth() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("hello", "hello world");
  assert.equal(delta, " world");
}

function testExtractThinkingDeltaForUnchangedSnapshot() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("hello", "hello");
  assert.equal(delta, "");
}

function testExtractThinkingDeltaForOverlap() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("The quick brown f", "fox jumps");
  assert.equal(delta, "ox jumps");
}

async function testWaitForUiPaintYieldsToMacrotask() {
  let settled = false;
  const paintPromise = __SESSION_CONTROLLER_TESTING__.waitForUiPaint().then(() => {
    settled = true;
  });

  assert.equal(settled, false);
  await Promise.resolve();
  assert.equal(settled, false);

  await paintPromise;
  assert.equal(settled, true);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
