import assert from "node:assert/strict";
import { __VIRTUAL_SCROLL_TESTING__ } from "./useVirtualScroll.js";

function runTests() {
  testDisabledRangeMountsAllEntries();
  testPendingDeltaExpandsProjectedRange();
  testStickyRangePinsToBottom();
  console.log("useVirtualScroll tests passed");
}

function testDisabledRangeMountsAllEntries() {
  const range = __VIRTUAL_SCROLL_TESTING__.resolveVirtualScrollRange({
    enabled: false,
    sticky: false,
    entryOffsets: [0, 4, 9],
    entryRowCounts: [4, 5, 3],
    totalRowCount: 12,
    scrollTop: 0,
    viewportHeight: 4,
    pendingDelta: 0,
    overscanRows: 0
  });

  assert.deepEqual(range, {
    startIndex: 0,
    endIndex: 3,
    topSpacerRows: 0,
    bottomSpacerRows: 0,
    clampMin: undefined,
    clampMax: undefined
  });
}

function testPendingDeltaExpandsProjectedRange() {
  const range = __VIRTUAL_SCROLL_TESTING__.resolveVirtualScrollRange({
    enabled: true,
    sticky: false,
    entryOffsets: [0, 5, 10, 15],
    entryRowCounts: [5, 5, 5, 5],
    totalRowCount: 20,
    scrollTop: 0,
    viewportHeight: 5,
    pendingDelta: 10,
    overscanRows: 0
  });

  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 3);
  assert.equal(range.topSpacerRows, 0);
  assert.equal(range.bottomSpacerRows, 5);
  assert.equal(range.clampMin, 0);
  assert.equal(range.clampMax, 10);
}

function testStickyRangePinsToBottom() {
  const range = __VIRTUAL_SCROLL_TESTING__.resolveVirtualScrollRange({
    enabled: true,
    sticky: true,
    entryOffsets: [0, 5, 10, 15],
    entryRowCounts: [5, 5, 5, 5],
    totalRowCount: 20,
    scrollTop: 0,
    viewportHeight: 5,
    pendingDelta: -10,
    overscanRows: 0
  });

  assert.equal(range.startIndex, 3);
  assert.equal(range.endIndex, 4);
  assert.equal(range.topSpacerRows, 15);
  assert.equal(range.bottomSpacerRows, 0);
  assert.equal(range.clampMin, 15);
  assert.equal(range.clampMax, 15);
}

runTests();
