import assert from "node:assert/strict";
import { __SESSION_CONTROLLER_TESTING__ } from "./sessionController.js";

function runTests() {
  testMergeThinkingContentSkipsWhitespaceChunk();
  testMergeThinkingContentAcceptsInitialChunk();
  testMergeThinkingContentPrefersCumulativeSnapshot();
  testMergeThinkingContentAppendsDeltaChunkWithoutLosingWhitespace();
  testMergeThinkingContentAvoidsDuplicateTailDelta();
  testMergeThinkingContentAppendsOnlyNonOverlappingSuffix();
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

runTests();
