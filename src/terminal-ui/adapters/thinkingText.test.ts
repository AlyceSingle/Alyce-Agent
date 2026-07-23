import assert from "node:assert/strict";
import { extractThinkingDelta, mergeThinkingContent } from "./thinkingText.js";

function runTests() {
  assert.equal(mergeThinkingContent("hello", "   "), "hello");
  assert.equal(mergeThinkingContent("", "hello"), "hello");
  assert.equal(mergeThinkingContent("hello", "hello world"), "hello world");
  assert.equal(mergeThinkingContent("hello", " world"), "hello world");
  assert.equal(extractThinkingDelta("", "hello"), "hello");
  assert.equal(extractThinkingDelta("hello", "hello world"), " world");
  assert.equal(extractThinkingDelta("hello", "hello"), "");
  console.log("thinkingText tests passed");
}

runTests();
