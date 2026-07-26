import assert from "node:assert/strict";
import { formatQueuedInputPreview } from "./QueuedInputPanel.js";

function runTests() {
  testCollapsesNewlinesIntoOneLine();
  testCollapsesRepeatedWhitespace();
  testTrimsSurroundingWhitespace();
  testLeavesPlainInputUnchanged();
  console.log("QueuedInputPanel tests passed");
}

// 多行输入必须压成单行，否则一条长输入会把输入区顶开。
function testCollapsesNewlinesIntoOneLine() {
  assert.equal(
    formatQueuedInputPreview("first line\nsecond line\r\nthird"),
    "first line second line third"
  );
}

function testCollapsesRepeatedWhitespace() {
  assert.equal(formatQueuedInputPreview("a     b\t\tc"), "a b c");
}

function testTrimsSurroundingWhitespace() {
  assert.equal(formatQueuedInputPreview("   padded   "), "padded");
}

function testLeavesPlainInputUnchanged() {
  assert.equal(formatQueuedInputPreview("run the tests"), "run the tests");
}

runTests();
