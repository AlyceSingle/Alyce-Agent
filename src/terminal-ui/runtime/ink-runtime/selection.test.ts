import assert from "node:assert/strict";
import {
  applySelectionOverlay,
  createSelectionState,
  selectLineAt
} from "./selection.js";
import {
  CellWidth,
  CharPool,
  cellAt,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool
} from "./screen.js";

function runTests() {
  testSelectionOverlayDoesNotPaintTrailingPadding();
  testSelectionOverlayKeepsInternalSpaces();
  testSelectionOverlayUsesSoftWrapContentEnd();
  console.log("selection tests passed");
}

function createTestScreen(width: number, height: number) {
  const stylePool = new StylePool();
  const screen = createScreen(
    width,
    height,
    stylePool,
    new CharPool(),
    new HyperlinkPool()
  );

  return { screen, stylePool };
}

function writeText(
  screen: ReturnType<typeof createScreen>,
  stylePool: StylePool,
  row: number,
  text: string
) {
  for (let col = 0; col < text.length; col++) {
    setCellAt(screen, col, row, {
      char: text[col]!,
      styleId: stylePool.none,
      width: CellWidth.Narrow,
      hyperlink: undefined
    });
  }
}

function applyLineSelection(
  screen: ReturnType<typeof createScreen>,
  stylePool: StylePool,
  row: number
) {
  const selection = createSelectionState();
  selectLineAt(selection, screen, row);
  applySelectionOverlay(screen, selection, stylePool);
}

function assertSelected(
  screen: ReturnType<typeof createScreen>,
  stylePool: StylePool,
  col: number,
  row: number
) {
  assert.notEqual(cellAt(screen, col, row)?.styleId, stylePool.none);
}

function assertNotSelected(
  screen: ReturnType<typeof createScreen>,
  stylePool: StylePool,
  col: number,
  row: number
) {
  assert.equal(cellAt(screen, col, row)?.styleId, stylePool.none);
}

function testSelectionOverlayDoesNotPaintTrailingPadding() {
  const { screen, stylePool } = createTestScreen(10, 1);
  writeText(screen, stylePool, 0, "foo");

  applyLineSelection(screen, stylePool, 0);

  assertSelected(screen, stylePool, 0, 0);
  assertSelected(screen, stylePool, 2, 0);
  assertNotSelected(screen, stylePool, 3, 0);
  assertNotSelected(screen, stylePool, 9, 0);
}

function testSelectionOverlayKeepsInternalSpaces() {
  const { screen, stylePool } = createTestScreen(10, 1);
  writeText(screen, stylePool, 0, "foo bar");

  applyLineSelection(screen, stylePool, 0);

  assertSelected(screen, stylePool, 0, 0);
  assertSelected(screen, stylePool, 3, 0);
  assertSelected(screen, stylePool, 6, 0);
  assertNotSelected(screen, stylePool, 7, 0);
}

function testSelectionOverlayUsesSoftWrapContentEnd() {
  const { screen, stylePool } = createTestScreen(10, 2);
  writeText(screen, stylePool, 0, "foo ");
  screen.softWrap[1] = 4;

  applyLineSelection(screen, stylePool, 0);

  assertSelected(screen, stylePool, 0, 0);
  assertSelected(screen, stylePool, 3, 0);
  assertNotSelected(screen, stylePool, 4, 0);
  assertNotSelected(screen, stylePool, 9, 0);
}

runTests();
