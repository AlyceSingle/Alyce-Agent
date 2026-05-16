import assert from "node:assert/strict";
import { createStructuredPatch } from "./structuredPatch.js";

function runTests() {
  testTrailingNewlineRemovalCreatesVisiblePatch();
  testTrailingNewlineAdditionCreatesVisiblePatch();
  console.log("structuredPatch tests passed");
}

function testTrailingNewlineRemovalCreatesVisiblePatch() {
  const patch = createStructuredPatch({
    filePath: "notes.txt",
    oldContent: "hello\n",
    newContent: "hello",
    includeFileHeader: true
  });

  assert.deepEqual(patch, [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        "--- notes.txt",
        "+++ notes.txt",
        "@@ -1,1 +1,1 @@",
        "-hello",
        "+hello",
        "\\ No newline at end of file"
      ]
    }
  ]);
}

function testTrailingNewlineAdditionCreatesVisiblePatch() {
  const patch = createStructuredPatch({
    oldContent: "hello",
    newContent: "hello\n"
  });

  assert.deepEqual(patch, [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        "@@ -1,1 +1,1 @@",
        "-hello",
        "\\ No newline at end of file",
        "+hello"
      ]
    }
  ]);
}

runTests();
