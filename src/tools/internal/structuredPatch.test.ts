import assert from "node:assert/strict";
import { createStructuredPatch } from "./structuredPatch.js";

function runTests() {
  testChangedLineIncludesNearbyContext();
  testDistantChangesStayInSeparateHunks();
  testTrailingNewlineRemovalCreatesVisiblePatch();
  testTrailingNewlineAdditionCreatesVisiblePatch();
  console.log("structuredPatch tests passed");
}

function testChangedLineIncludesNearbyContext() {
  const patch = createStructuredPatch({
    oldContent: "one\ntwo\nthree\nfour\nfive\n",
    newContent: "one\ntwo\nTHREE\nfour\nfive\n"
  });

  assert.deepEqual(patch, [
    {
      oldStart: 2,
      oldLines: 3,
      newStart: 2,
      newLines: 3,
      lines: [
        "@@ -2,3 +2,3 @@",
        " two",
        "-three",
        "+THREE",
        " four"
      ]
    }
  ]);
}

function testDistantChangesStayInSeparateHunks() {
  const oldContent = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const newContent = [
    "line 1",
    "line two",
    "line 3",
    "line 4",
    "line 5",
    "line 6",
    "line 7",
    "line 8",
    "line 9",
    "line 10",
    "line eleven",
    "line 12"
  ].join("\n") + "\n";

  assert.deepEqual(createStructuredPatch({ oldContent, newContent }), [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        "@@ -1,3 +1,3 @@",
        " line 1",
        "-line 2",
        "+line two",
        " line 3"
      ]
    },
    {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      lines: [
        "@@ -10,3 +10,3 @@",
        " line 10",
        "-line 11",
        "+line eleven",
        " line 12"
      ]
    }
  ]);
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
