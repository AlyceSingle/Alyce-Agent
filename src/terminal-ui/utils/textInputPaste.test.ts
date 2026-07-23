import assert from "node:assert/strict";
import {
  buildInputEditorViewport,
  codePointIndexToUtf16Offset,
  moveCursorVertically,
  utf16OffsetToCodePointIndex
} from "../utils/text.js";
import { clampCursorOffset, normalizeEditableText } from "../hooks/useTextInput.js";

function runTests() {
  assert.equal(normalizeEditableText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(normalizeEditableText("a\u0000b"), "ab");
  assert.equal(clampCursorOffset("abc", 99), 3);
  assert.equal(clampCursorOffset("abc", -1), 0);

  const emoji = "hi😀";
  const endUtf16 = emoji.length;
  const endCp = utf16OffsetToCodePointIndex(emoji, endUtf16);
  assert.equal(endCp, 3);
  assert.equal(codePointIndexToUtf16Offset(emoji, endCp), endUtf16);

  const viewport = buildInputEditorViewport("line1\nline2", "line1\nline2".length, 40, 4);
  const cursorLine = viewport.lines.find((line) => line.isCursorLine);
  assert.ok(cursorLine);
  assert.equal(cursorLine?.current, " ");

  const crViewport = buildInputEditorViewport(
    normalizeEditableText("from\r\nterminal"),
    normalizeEditableText("from\r\nterminal").length,
    40,
    4
  );
  assert.ok(crViewport.lines.some((line) => line.isCursorLine && line.current === " "));

  const moved = moveCursorVertically("a\nb\nc", 0, 40, 1);
  assert.equal(moved, 2); // after "a\n"

  console.log("text input paste/cursor tests passed");
}

runTests();
