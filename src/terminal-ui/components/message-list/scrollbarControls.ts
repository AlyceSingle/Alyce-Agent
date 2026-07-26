import type React from "react";
import type { ScrollBoxHandle } from "../../runtime/ink-runtime/components/ScrollBox.js";
import type { useSelection } from "../../runtime/ink-runtime/hooks/use-selection.js";
import type { MouseEvent as TerminalMouseEvent } from "../../runtime/ink-runtime/events/mouse-event.js";
import { resolveScrollIndicatorMetrics } from "./scrollMetrics.js";
import type { ScrollIndicatorState } from "./messageListTypes.js";

const SCROLLBAR_FADE_MS = 900;

export function createScrollbarControls(options: {
  scrollRef: { current: ScrollBoxHandle | null };
  scrollIndicatorTimeoutRef: { current: ReturnType<typeof setTimeout> | null };
  scrollDragOffsetRef: { current: number | null };
  selection: ReturnType<typeof useSelection>;
  scrollIndicator: ScrollIndicatorState;
  setScrollIndicator: React.Dispatch<React.SetStateAction<ScrollIndicatorState>>;
}) {
  const {
    scrollRef,
    scrollIndicatorTimeoutRef,
    scrollDragOffsetRef,
    selection,
    scrollIndicator,
    setScrollIndicator
  } = options;

  function armScrollIndicatorFade() {
    if (scrollIndicatorTimeoutRef.current) {
      clearTimeout(scrollIndicatorTimeoutRef.current);
    }
    scrollIndicatorTimeoutRef.current = setTimeout(() => {
      scrollIndicatorTimeoutRef.current = null;
      setScrollIndicator((previous) => (
        previous.active
          ? {
              ...previous,
              active: false
            }
          : previous
      ));
    }, SCROLLBAR_FADE_MS);
  }

  function activateScrollIndicator() {
    setScrollIndicator((previous) => (
      previous.visible && !previous.active
        ? {
            ...previous,
            active: true
          }
        : previous
    ));
    armScrollIndicatorFade();
  }

  function getCurrentScrollIndicatorState() {
    const handle = scrollRef.current;
    if (!handle) {
      return null;
    }

    const viewportHeight = handle.getViewportHeight();
    const scrollHeight = Math.max(
      handle.getScrollHeight(),
      handle.getFreshScrollHeight()
    );

    return {
      scrollTop: handle.getScrollTop(),
      viewportHeight,
      scrollHeight,
      visible: scrollHeight > viewportHeight,
      active: true
    } satisfies ScrollIndicatorState;
  }

  function applyScrollbarPosition(localRow: number, dragOffset: number) {
    const handle = scrollRef.current;
    const nextState = getCurrentScrollIndicatorState();
    if (!handle || !nextState) {
      return;
    }

    const metrics = resolveScrollIndicatorMetrics(nextState);
    if (!metrics.visible) {
      return;
    }

    const thumbTop = Math.max(
      0,
      Math.min(metrics.maxThumbTop, Math.round(localRow - dragOffset))
    );
    const scrollTop =
      metrics.maxThumbTop === 0
        ? 0
        : Math.round((thumbTop / metrics.maxThumbTop) * metrics.maxScrollTop);

    scrollManuallyTo(scrollTop);
    activateScrollIndicator();
  }

  function maybeShiftSelectionForManualScroll(actualDelta: number) {
    if (actualDelta === 0) {
      return;
    }

    const state = selection.getState();
    if (!state?.anchor) {
      return;
    }

    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const viewportTop = handle.getViewportTop();
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const viewportBottom = viewportTop + viewportHeight - 1;
    const anchorInViewport =
      state.anchor.row >= viewportTop && state.anchor.row <= viewportBottom;

    if (!anchorInViewport) {
      return;
    }

    if (state.isDragging) {
      if (selection.hasSelection()) {
        if (actualDelta > 0) {
          selection.captureScrolledRows(viewportTop, viewportTop + actualDelta - 1, "above");
        } else {
          selection.captureScrolledRows(viewportBottom + actualDelta + 1, viewportBottom, "below");
        }
      }
      selection.shiftAnchor(-actualDelta, viewportTop, viewportBottom);
      return;
    }

    const focusInViewport =
      !state.focus ||
      (state.focus.row >= viewportTop && state.focus.row <= viewportBottom);

    if (!focusInViewport || !selection.hasSelection()) {
      return;
    }

    if (actualDelta > 0) {
      selection.captureScrolledRows(viewportTop, viewportTop + actualDelta - 1, "above");
    } else {
      selection.captureScrolledRows(viewportBottom + actualDelta + 1, viewportBottom, "below");
    }

    selection.shiftSelection(-actualDelta, viewportTop, viewportBottom);
  }

  function scrollManuallyBy(requestedDelta: number) {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const currentScrollTop = handle.getScrollTop();
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    const nextScrollTop = Math.max(0, Math.min(currentScrollTop + requestedDelta, maxScrollTop));
    const actualDelta = nextScrollTop - currentScrollTop;

    if (actualDelta === 0) {
      return;
    }

    maybeShiftSelectionForManualScroll(actualDelta);
    handle.scrollBy(actualDelta);
  }

  function scrollManuallyTo(targetScrollTop: number) {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const currentScrollTop = handle.getScrollTop();
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    const nextScrollTop = Math.max(0, Math.min(Math.floor(targetScrollTop), maxScrollTop));
    const actualDelta = nextScrollTop - currentScrollTop;

    if (actualDelta === 0) {
      return;
    }

    maybeShiftSelectionForManualScroll(actualDelta);
    handle.scrollTo(nextScrollTop);
  }

  function handleScrollbarMouseDown(event: TerminalMouseEvent) {
    if (event.button !== 0) {
      return;
    }

    const nextState = getCurrentScrollIndicatorState();
    if (!nextState) {
      return;
    }

    const metrics = resolveScrollIndicatorMetrics(nextState);
    if (!metrics.visible) {
      return;
    }

    const localRow = Math.max(0, Math.min(metrics.height - 1, event.localRow));
    const clickedThumb =
      localRow >= metrics.thumbTop && localRow < metrics.thumbTop + metrics.thumbHeight;
    const dragOffset = clickedThumb
      ? localRow - metrics.thumbTop
      : Math.floor(metrics.thumbHeight / 2);

    scrollDragOffsetRef.current = dragOffset;
    applyScrollbarPosition(localRow, dragOffset);
  }

  function handleScrollbarMouseMove(event: TerminalMouseEvent) {
    const dragOffset = scrollDragOffsetRef.current;
    if (dragOffset === null) {
      return;
    }

    const viewportHeight = Math.max(1, scrollIndicator.viewportHeight);
    const localRow = Math.max(0, Math.min(viewportHeight - 1, event.localRow));
    applyScrollbarPosition(localRow, dragOffset);
  }

  function handleScrollbarMouseUp() {
    if (scrollDragOffsetRef.current === null) {
      return;
    }

    scrollDragOffsetRef.current = null;
    armScrollIndicatorFade();
  }

  return {
    armScrollIndicatorFade,
    activateScrollIndicator,
    scrollManuallyBy,
    scrollManuallyTo,
    handleScrollbarMouseDown,
    handleScrollbarMouseMove,
    handleScrollbarMouseUp
  };
}
