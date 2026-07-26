import type { ScrollBoxHandle } from "../../runtime/ink-runtime/components/ScrollBox.js";
import { terminalUiTheme } from "../../theme/theme.js";
import type {
  RenderedMessageEntry,
  ScrollIndicatorLine,
  ScrollIndicatorMetrics,
  ScrollIndicatorState
} from "./messageListTypes.js";

const SCROLL_HEADROOM_ROWS = 2;
const SCROLLBAR_TRACK_CHAR = "╎╎";
const SCROLLBAR_THUMB_IDLE_CHAR = "││";
const SCROLLBAR_THUMB_ACTIVE_CHAR = "┃┃";

export function isHandleAtBottom(handle: ScrollBoxHandle) {
  const scrollTop = handle.getScrollTop();
  const viewportHeight = handle.getViewportHeight();
  const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());

  return scrollTop + viewportHeight >= Math.max(0, scrollHeight - SCROLL_HEADROOM_ROWS);
}

export function buildScrollIndicatorLines(state: ScrollIndicatorState): ScrollIndicatorLine[] {
  const metrics = resolveScrollIndicatorMetrics(state);
  if (!metrics.visible || metrics.height === 0) {
    return Array.from({ length: metrics.height }, (_, index) => ({
      key: `scroll-indicator-empty-${index}`,
      char: " ",
      color: terminalUiTheme.colors.scrollbarTrack,
      dimColor: true
    }));
  }

  return Array.from({ length: metrics.height }, (_, index) => {
    const isThumb = index >= metrics.thumbTop && index < metrics.thumbTop + metrics.thumbHeight;
    return {
      key: `scroll-indicator-${index}`,
      char: isThumb
        ? (state.active ? SCROLLBAR_THUMB_ACTIVE_CHAR : SCROLLBAR_THUMB_IDLE_CHAR)
        : SCROLLBAR_TRACK_CHAR,
      color: isThumb
        ? (state.active ? terminalUiTheme.colors.scrollbarThumbActive : terminalUiTheme.colors.scrollbarThumb)
        : terminalUiTheme.colors.scrollbarTrack,
      dimColor: !isThumb
    };
  });
}

export function resolveScrollIndicatorMetrics(state: ScrollIndicatorState): ScrollIndicatorMetrics {
  const height = Math.max(0, state.viewportHeight);
  if (!state.visible || height === 0 || state.scrollHeight <= state.viewportHeight) {
    return {
      height,
      visible: false,
      thumbHeight: 0,
      thumbTop: 0,
      maxThumbTop: 0,
      maxScrollTop: 0
    };
  }

  const maxScrollTop = Math.max(1, state.scrollHeight - state.viewportHeight);
  const minimumThumbHeight = height >= 6 ? 2 : 1;
  const thumbHeight = Math.min(
    height,
    Math.max(minimumThumbHeight, Math.round((state.viewportHeight / state.scrollHeight) * height))
  );
  const maxThumbTop = Math.max(0, height - thumbHeight);
  const thumbTop = Math.min(
    maxThumbTop,
    Math.max(0, Math.round((state.scrollTop / maxScrollTop) * maxThumbTop))
  );

  return {
    height,
    visible: true,
    thumbHeight,
    thumbTop,
    maxThumbTop,
    maxScrollTop
  };
}

export function resolveVisibleMessageId(
  renderedEntries: RenderedMessageEntry[],
  entryOffsets: number[],
  scrollTop: number
) {
  if (renderedEntries.length === 0) {
    return null;
  }

  const viewportTop = Math.max(0, Math.floor(scrollTop));
  let left = 0;
  let right = entryOffsets.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const top = entryOffsets[middle] ?? 0;
    const bottomExclusive = top + Math.max(1, renderedEntries[middle]?.rowCount ?? 1);
    if (bottomExclusive <= viewportTop) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  const index = Math.max(0, Math.min(renderedEntries.length - 1, left));
  if (index >= 0) {
    return renderedEntries[index]?.message.id ?? renderedEntries.at(-1)?.message.id ?? null;
  }

  return renderedEntries[0]?.message.id ?? null;
}

export function resolvePrependedMessageIds(previousIds: string[], nextIds: string[]) {
  if (previousIds.length === 0 || nextIds.length <= previousIds.length) {
    return [];
  }

  const prependCount = nextIds.length - previousIds.length;
  for (let index = 0; index < previousIds.length; index += 1) {
    if (nextIds[prependCount + index] !== previousIds[index]) {
      return [];
    }
  }

  return nextIds.slice(0, prependCount);
}
