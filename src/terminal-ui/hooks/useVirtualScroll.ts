import { useEffect, useMemo, useState, type RefObject } from "react";
import type { ScrollBoxHandle } from "../runtime/ink.js";

export type VirtualScrollRange = {
  startIndex: number;
  endIndex: number;
  topSpacerRows: number;
  bottomSpacerRows: number;
  clampMin: number | undefined;
  clampMax: number | undefined;
};

type ResolveVirtualScrollRangeOptions = {
  enabled: boolean;
  sticky: boolean;
  entryOffsets: number[];
  entryRowCounts: number[];
  totalRowCount: number;
  scrollTop: number;
  viewportHeight: number;
  pendingDelta: number;
  overscanRows: number;
};

type UseVirtualScrollOptions = {
  enabled: boolean;
  sticky: boolean;
  entryOffsets: number[];
  entryRowCounts: number[];
  totalRowCount: number;
  scrollHandleRef: RefObject<ScrollBoxHandle | null>;
  overscanRows?: number;
};

const DEFAULT_OVERSCAN_ROWS = 60;

function upperBound(values: number[], target: number) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if ((values[middle] ?? 0) <= target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function findFirstIntersectingIndex(
  offsets: number[],
  rowCounts: number[],
  row: number
) {
  let left = 0;
  let right = offsets.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const top = offsets[middle] ?? 0;
    const bottomExclusive = top + Math.max(1, rowCounts[middle] ?? 1);
    if (bottomExclusive <= row) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function buildFullRange(
  entryOffsets: number[],
  entryRowCounts: number[],
  totalRowCount: number
): VirtualScrollRange {
  if (entryOffsets.length === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerRows: 0,
      bottomSpacerRows: 0,
      clampMin: undefined,
      clampMax: undefined
    };
  }

  const lastIndex = entryOffsets.length - 1;
  const mountedBottomExclusive =
    (entryOffsets[lastIndex] ?? 0) + Math.max(1, entryRowCounts[lastIndex] ?? 1);

  return {
    startIndex: 0,
    endIndex: entryOffsets.length,
    topSpacerRows: 0,
    bottomSpacerRows: Math.max(0, totalRowCount - mountedBottomExclusive),
    clampMin: undefined,
    clampMax: undefined
  };
}

export function resolveVirtualScrollRange(
  options: ResolveVirtualScrollRangeOptions
): VirtualScrollRange {
  if (options.entryOffsets.length === 0 || options.entryRowCounts.length === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerRows: 0,
      bottomSpacerRows: 0,
      clampMin: undefined,
      clampMax: undefined
    };
  }

  if (!options.enabled) {
    return buildFullRange(options.entryOffsets, options.entryRowCounts, options.totalRowCount);
  }

  const viewportHeight = Math.max(1, options.viewportHeight);
  const overscanRows = Math.max(0, Math.floor(options.overscanRows));
  const maxScrollTop = Math.max(0, options.totalRowCount - viewportHeight);
  const committedTop = options.sticky
    ? maxScrollTop
    : Math.max(0, Math.min(Math.floor(options.scrollTop), maxScrollTop));
  const pendingDelta = options.sticky ? 0 : Math.floor(options.pendingDelta);
  const projectedTop = Math.max(0, Math.min(committedTop + pendingDelta, maxScrollTop));
  const committedBottom = committedTop + viewportHeight - 1;
  const projectedBottom = projectedTop + viewportHeight - 1;
  const rangeTop = Math.max(
    0,
    Math.min(committedTop, projectedTop) - overscanRows
  );
  const rangeBottom = Math.min(
    Math.max(0, options.totalRowCount - 1),
    Math.max(committedBottom, projectedBottom) + overscanRows
  );

  const startIndex = Math.min(
    options.entryOffsets.length - 1,
    findFirstIntersectingIndex(options.entryOffsets, options.entryRowCounts, rangeTop)
  );
  let endIndex = Math.max(
    startIndex + 1,
    upperBound(options.entryOffsets, rangeBottom)
  );
  if (endIndex > options.entryOffsets.length) {
    endIndex = options.entryOffsets.length;
  }

  const topSpacerRows = options.entryOffsets[startIndex] ?? 0;
  const mountedBottomExclusive =
    (options.entryOffsets[endIndex - 1] ?? 0) +
    Math.max(1, options.entryRowCounts[endIndex - 1] ?? 1);
  const bottomSpacerRows = Math.max(0, options.totalRowCount - mountedBottomExclusive);
  const clampMin = topSpacerRows;
  const clampMax = Math.max(clampMin, mountedBottomExclusive - viewportHeight);

  return {
    startIndex,
    endIndex,
    topSpacerRows,
    bottomSpacerRows,
    clampMin,
    clampMax
  };
}

export function useVirtualScroll(options: UseVirtualScrollOptions): VirtualScrollRange {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!options.enabled) {
      return;
    }

    const notify = () => {
      setRevision((current) => current + 1);
    };
    notify();

    const handle = options.scrollHandleRef.current;
    if (!handle) {
      return;
    }

    const timeout = setTimeout(notify, 0);
    const unsubscribe = handle.subscribe(notify);
    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [
    options.enabled,
    options.entryOffsets.length,
    options.scrollHandleRef,
    options.totalRowCount
  ]);

  const range = useMemo(() => {
    const handle = options.scrollHandleRef.current;
    const scrollTop = handle?.getScrollTop() ?? 0;
    const viewportHeight = handle?.getViewportHeight() ?? 0;
    const pendingDelta = options.enabled ? handle?.getPendingDelta() ?? 0 : 0;
    return resolveVirtualScrollRange({
      enabled: options.enabled,
      sticky: options.sticky,
      entryOffsets: options.entryOffsets,
      entryRowCounts: options.entryRowCounts,
      totalRowCount: options.totalRowCount,
      scrollTop,
      viewportHeight,
      pendingDelta,
      overscanRows: options.overscanRows ?? DEFAULT_OVERSCAN_ROWS
    });
  }, [
    options.enabled,
    options.entryOffsets,
    options.entryRowCounts,
    options.overscanRows,
    options.scrollHandleRef,
    options.sticky,
    options.totalRowCount,
    revision
  ]);

  useEffect(() => {
    const handle = options.scrollHandleRef.current;
    if (!handle) {
      return;
    }

    if (!options.enabled || options.sticky) {
      handle.setClampBounds(undefined, undefined);
      return;
    }

    handle.setClampBounds(range.clampMin, range.clampMax);
    return () => {
      handle.setClampBounds(undefined, undefined);
    };
  }, [options.enabled, options.scrollHandleRef, options.sticky, range.clampMax, range.clampMin]);

  return range;
}

export const __VIRTUAL_SCROLL_TESTING__ = {
  resolveVirtualScrollRange,
  upperBound,
  findFirstIntersectingIndex
} as const;
