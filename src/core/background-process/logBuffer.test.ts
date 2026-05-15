import assert from "node:assert/strict";
import { LogBuffer, tailLines } from "./logBuffer.js";

function runTests() {
  testTrimsToMaxBytesWithoutBreakingTextModel();
  testReturnsTailLines();
  console.log("logBuffer tests passed");
}

function testTrimsToMaxBytesWithoutBreakingTextModel() {
  const buffer = new LogBuffer({ maxBytes: 8 });
  buffer.append("hello");
  buffer.append("世界");

  assert.ok(Buffer.byteLength(buffer.getText(), "utf8") <= 8);
  assert.ok(buffer.getText().endsWith("世界"));
}

function testReturnsTailLines() {
  assert.equal(tailLines("one\ntwo\nthree\n", 2), "two\nthree\n");
  assert.equal(tailLines("one\ntwo\nthree", 1), "three");
  assert.equal(tailLines("one\ntwo", 0), "");
}

runTests();
