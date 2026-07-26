import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import { isStreamingUiMessage } from "../adapters/messageMapper.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import ScrollBox, { type ScrollBoxHandle } from "../runtime/ink-runtime/components/ScrollBox.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import { useSelection } from "../runtime/ink-runtime/hooks/use-selection.js";
import type { ClickEvent as TerminalClickEvent } from "../runtime/ink-runtime/events/click-event.js";
import type { TerminalUiMessage } from "../state/types.js";
import { isContextPreviewMessage } from "../utils/messageBlocks.js";
import { createRenderPolicy } from "../utils/renderPolicy.js";
import { logForDebugging } from "../runtime/utils/debug.js";
import { logLayoutTrace } from "../runtime/utils/layoutTrace.js";
import { isEnvTruthy } from "../runtime/utils/envUtils.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import {
  buildHeaderSegments,
  buildShellCommandHeaderSegments,
  getMessagePalette
} from "./message-list/headerSegments.js";
import {
  getRenderedLineColors,
  renderBlockLines
} from "./message-list/sectionRendering.js";
import {
  buildCollapsedMessageBlocks,
  buildCollapsedToolBlocks,
  combineShellOutput,
  isCollapsibleSystemMessage,
  isDefaultExpandedMessage,
  isMessageExpanded,
  renderToolMessageState
} from "./message-list/expandableState.js";
import {
  buildRenderedMessageEntries,
  sliceMessagesForNonVirtualizedList,
  type RenderedEntryCacheRecord
} from "./message-list/renderedEntries.js";
import {
  buildScrollIndicatorLines,
  isHandleAtBottom,
  resolvePrependedMessageIds,
  resolveVisibleMessageId
} from "./message-list/scrollMetrics.js";
import { createScrollbarControls } from "./message-list/scrollbarControls.js";
import { TranscriptRows } from "./message-list/TranscriptRows.js";
import type { ScrollIndicatorState } from "./message-list/messageListTypes.js";

const MESSAGE_CONTENT_WIDTH_OFFSET = 14;
const SCROLLBAR_WIDTH = 2;
const NEAR_TOP_TRIGGER_ROWS = 1;
const SCROLL_PERF_LOG_ENABLED =
  isEnvTruthy(process.env.ALYCE_SCROLL_PERF_LOG) ||
  isEnvTruthy(process.env.CLAUDE_CODE_SCROLL_PERF_LOG);
const VIRTUAL_SCROLL_ENABLED = !isEnvTruthy(process.env.ALYCE_DISABLE_VIRTUAL_SCROLL);
const SCROLL_PERF_FLUSH_INTERVAL_MS = 1500;
const SCROLL_PERF_SLOW_SYNC_THRESHOLD_MS = 8;

export type MessageListHandle = {
  scrollBy: (delta: number) => void;
  scrollPage: (delta: -1 | 1) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  refreshViewport: () => void;
  getVisibleMessageId: () => string | null;
};

export const __MESSAGE_LIST_TESTING__ = {
  getMessagePalette,
  getRenderedLineColors,
  renderBlockLines,
  buildCollapsedMessageBlocks,
  buildCollapsedToolBlocks,
  combineShellOutput,
  buildHeaderSegments,
  buildShellCommandHeaderSegments,
  renderToolMessageState,
  buildRenderedMessageEntries,
  sliceMessagesForNonVirtualizedList,
  resolveVisibleMessageId,
  resolvePrependedMessageIds
} as const;

const MessageListImpl = forwardRef<MessageListHandle, {
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  viewportWidth: number;
  markdownEnabled: boolean;
  markdownToolMessageRenderingEnabled: boolean;
  markdownRenderMaxChars: number;
  thinkingMessagesExpandedByDefault: boolean;
  showMessageTimestamps: boolean;
  maxMessagesWithoutVirtualization: number;
  isLoading: boolean;
  assistantLabel: string;
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  onStickyChange: (sticky: boolean) => void;
  onNearTop?: (visibleMessageId: string | null) => void;
}>(function MessageList(props, ref) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const scrollIndicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollDragOffsetRef = useRef<number | null>(null);
  const visibleMessageIdRef = useRef<string | null>(props.selectedMessageId);
  const selectedMessageSnapshotRef = useRef<string | null>(props.selectedMessageId);
  const stickySnapshotRef = useRef(true);
  const nearTopSnapshotRef = useRef(false);
  const previousMessageIdsRef = useRef<string[]>(props.messages.map((message) => message.id));
  const pendingPrependMessageIdsRef = useRef<string[]>([]);
  const thinkingDefaultExpandedRef = useRef(props.thinkingMessagesExpandedByDefault);
  const selection = useSelection();
  const [expandedMessageIds, setExpandedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollIndicator, setScrollIndicator] = useState<ScrollIndicatorState>({
    scrollTop: 0,
    viewportHeight: 0,
    scrollHeight: 0,
    visible: false,
    active: false
  });
  const layoutSignatureRef = useRef<{
    contentWidth: number;
    messageCount: number;
    totalRowCount: number;
  } | null>(null);
  const layoutPerfSignatureRef = useRef<string | null>(null);
  const scrollSyncPerfRef = useRef({
    sampleCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastFlushAtMs: Date.now()
  });
  const contentWidth = Math.max(24, props.viewportWidth - MESSAGE_CONTENT_WIDTH_OFFSET);
  const stickySnapshot = stickySnapshotRef.current;
  const visibleMessageIdSnapshot = visibleMessageIdRef.current;
  const sourceMessages = useMemo(
    () => {
      if (VIRTUAL_SCROLL_ENABLED) {
        return props.messages;
      }

      return sliceMessagesForNonVirtualizedList({
        messages: props.messages,
        maxMessages: props.maxMessagesWithoutVirtualization,
        sticky: stickySnapshot,
        visibleMessageId: visibleMessageIdSnapshot,
        selectedMessageId: props.selectedMessageId,
        unseenDividerMessageId: props.unseenDividerMessageId
      });
    },
    [
      props.maxMessagesWithoutVirtualization,
      props.messages,
      props.selectedMessageId,
      props.unseenDividerMessageId,
      stickySnapshot,
      visibleMessageIdSnapshot
    ]
  );
  const renderPolicy = useMemo(
    () =>
      createRenderPolicy({
        markdownMessageRenderingEnabled: props.markdownEnabled,
        markdownToolMessageRenderingEnabled: props.markdownToolMessageRenderingEnabled,
        markdownRenderMaxChars: props.markdownRenderMaxChars
      }),
    [
      props.markdownEnabled,
      props.markdownToolMessageRenderingEnabled,
      props.markdownRenderMaxChars
    ]
  );
  const liveMarkdownMessageId = useMemo(() => {
    if (!props.isLoading) {
      return null;
    }

    for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
      const message = sourceMessages[index];
      if (!message) {
        continue;
      }

      // 流式 assistant 走纯文本，不必标成 live markdown（否则签名抖动、缓存失效）。
      if (
        (message.kind === "thinking" || message.kind === "assistant") &&
        message.content.trim().length > 0 &&
        !isStreamingUiMessage(message)
      ) {
        return message.id;
      }
    }

    return null;
  }, [props.isLoading, sourceMessages]);

  const renderedEntryCacheRef = useRef(new Map<string, RenderedEntryCacheRecord>());
  const renderedEntries = useMemo(
    () =>
      buildRenderedMessageEntries(
        sourceMessages,
        props.selectedMessageId,
        contentWidth,
        renderPolicy,
        expandedMessageIds,
        props.assistantLabel,
        props.unseenDividerMessageId,
        liveMarkdownMessageId,
        props.thinkingMessagesExpandedByDefault,
        renderedEntryCacheRef.current
      ),
    [
      contentWidth,
      expandedMessageIds,
      props.assistantLabel,
      liveMarkdownMessageId,
      sourceMessages,
      renderPolicy,
      props.selectedMessageId,
      props.unseenDividerMessageId,
      props.thinkingMessagesExpandedByDefault
    ]
  );
  const entryRowCounts = useMemo(
    () => renderedEntries.map((entry) => entry.rowCount),
    [renderedEntries]
  );
  const totalRowCount = useMemo(
    () => renderedEntries.reduce((sum, entry) => sum + entry.rowCount, 0),
    [renderedEntries]
  );
  const entryOffsets = useMemo(() => {
    let offset = 0;
    return renderedEntries.map((entry) => {
      const top = offset;
      offset += entry.rowCount;
      return top;
    });
  }, [renderedEntries]);
  const scrollIndicatorLines = useMemo(
    () => buildScrollIndicatorLines(scrollIndicator),
    [scrollIndicator]
  );
  const virtualRange = useVirtualScroll({
    enabled: VIRTUAL_SCROLL_ENABLED,
    sticky: stickySnapshot,
    entryOffsets,
    entryRowCounts,
    totalRowCount,
    scrollHandleRef: scrollRef
  });

  useEffect(() => {
    const handle = scrollRef.current;
    logLayoutTrace("message-list:layout", {
      viewportWidth: props.viewportWidth,
      contentWidth,
      messages: props.messages.length,
      totalRowCount,
      sticky: stickySnapshotRef.current,
      scrollTop: handle?.getScrollTop() ?? null,
      viewportHeight: handle?.getViewportHeight() ?? null,
      scrollHeight: handle ? Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight()) : null
    });
  }, [contentWidth, props.messages.length, props.viewportWidth, totalRowCount]);

  useEffect(() => {
    const previousIds = previousMessageIdsRef.current;
    const nextIds = props.messages.map((message) => message.id);
    const prependedIds = resolvePrependedMessageIds(previousIds, nextIds);
    if (prependedIds.length > 0 && !stickySnapshotRef.current) {
      pendingPrependMessageIdsRef.current = prependedIds;
    } else {
      pendingPrependMessageIdsRef.current = [];
    }
    previousMessageIdsRef.current = nextIds;
  }, [props.messages]);

  const {
    armScrollIndicatorFade,
    activateScrollIndicator,
    scrollManuallyBy,
    scrollManuallyTo,
    handleScrollbarMouseDown,
    handleScrollbarMouseMove,
    handleScrollbarMouseUp
  } = createScrollbarControls({
    scrollRef,
    scrollIndicatorTimeoutRef,
    scrollDragOffsetRef,
    selection,
    scrollIndicator,
    setScrollIndicator
  });

  const handleExpandableMessageClick = useCallback(
    (message: TerminalUiMessage, event: TerminalClickEvent) => {
      if (event.cellIsBlank) {
        return;
      }

      setExpandedMessageIds((previous) => {
        const next = new Set(previous);
        const expanded = isMessageExpanded(
          message,
          previous,
          props.thinkingMessagesExpandedByDefault
        );

        if (isDefaultExpandedMessage(message, props.thinkingMessagesExpandedByDefault)) {
          if (expanded) {
            next.add(message.id);
          } else {
            next.delete(message.id);
          }
          return next;
        }

        if (expanded) {
          next.delete(message.id);
        } else {
          next.add(message.id);
        }

        return next;
      });
    },
    [props.thinkingMessagesExpandedByDefault]
  );

  useEffect(() => {
    if (thinkingDefaultExpandedRef.current === props.thinkingMessagesExpandedByDefault) {
      return;
    }

    thinkingDefaultExpandedRef.current = props.thinkingMessagesExpandedByDefault;
    setExpandedMessageIds((previous) => {
      const thinkingIds = new Set(
        sourceMessages
          .filter((message) => message.kind === "thinking")
          .map((message) => message.id)
      );
      if (thinkingIds.size === 0) {
        return previous;
      }

      const next = new Set<string>();
      let changed = false;
      for (const id of previous) {
        if (thinkingIds.has(id)) {
          changed = true;
        } else {
          next.add(id);
        }
      }

      return changed ? next : previous;
    });
  }, [props.thinkingMessagesExpandedByDefault, sourceMessages]);

  useEffect(() => {
    setExpandedMessageIds((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const validIds = new Set(
        sourceMessages
          .filter((message) =>
            message.kind === "tool" ||
            message.kind === "thinking" ||
            isContextPreviewMessage(message) ||
            isCollapsibleSystemMessage(message)
          )
          .map((message) => message.id)
      );
      const next = new Set<string>();
      let changed = false;
      for (const id of previous) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [sourceMessages]);

  useImperativeHandle(ref, () => ({
    scrollBy: (delta) => {
      scrollManuallyBy(delta);
    },
    scrollPage: (delta) => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      const pageStep = Math.max(1, handle.getViewportHeight() - 2);
      scrollManuallyBy(delta * pageStep);
    },
    scrollToTop: () => {
      scrollManuallyTo(0);
    },
    scrollToBottom: () => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      const viewportHeight = Math.max(1, handle.getViewportHeight());
      const scrollHeight = Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight());
      scrollManuallyTo(Math.max(0, scrollHeight - viewportHeight));
    },
    refreshViewport: () => {
      const handle = scrollRef.current;
      if (!handle) {
        return;
      }

      const shouldStick =
        stickySnapshotRef.current || handle.isSticky() || isHandleAtBottom(handle);
      if (shouldStick) {
        handle.scrollToBottom();
        return;
      }

      handle.scrollTo(handle.getScrollTop());
    },
    getVisibleMessageId: () =>
      visibleMessageIdRef.current ??
      props.selectedMessageId ??
      props.messages.at(-1)?.id ??
      null
  }), [props.messages, props.selectedMessageId, selection]);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const syncScrollState = () => {
      const syncStartedAtMs = SCROLL_PERF_LOG_ENABLED ? Date.now() : 0;
      const currentHandle = scrollRef.current;
      if (!currentHandle) {
        return;
      }

      const scrollTop = currentHandle.getScrollTop();
      const viewportHeight = currentHandle.getViewportHeight();
      const scrollHeight = Math.max(
        currentHandle.getScrollHeight(),
        currentHandle.getFreshScrollHeight()
      );
      const isAtBottom = isHandleAtBottom(currentHandle);
      const effectiveSticky = currentHandle.isSticky() || isAtBottom;

      logLayoutTrace("message-list:scroll-sync", {
        contentWidth,
        scrollTop,
        viewportHeight,
        scrollHeight,
        isAtBottom,
        effectiveSticky,
        totalRowCount
      });

      stickySnapshotRef.current = effectiveSticky;
      props.onStickyChange(effectiveSticky);
      visibleMessageIdRef.current = resolveVisibleMessageId(
        renderedEntries,
        entryOffsets,
        scrollTop
      );
      const nearTop = scrollTop <= NEAR_TOP_TRIGGER_ROWS;
      if (nearTop && !nearTopSnapshotRef.current) {
        props.onNearTop?.(visibleMessageIdRef.current);
      }
      nearTopSnapshotRef.current = nearTop;
      setScrollIndicator((previous) => {
        const visible = scrollHeight > viewportHeight;
        if (
          previous.scrollTop === scrollTop &&
          previous.viewportHeight === viewportHeight &&
          previous.scrollHeight === scrollHeight &&
          previous.visible === visible &&
          previous.active
        ) {
          return previous;
        }

        return {
          scrollTop,
          viewportHeight,
          scrollHeight,
          visible,
          active: true
        };
      });
      armScrollIndicatorFade();

      if (!SCROLL_PERF_LOG_ENABLED) {
        return;
      }

      const durationMs = Date.now() - syncStartedAtMs;
      const stats = scrollSyncPerfRef.current;
      stats.sampleCount += 1;
      stats.totalDurationMs += durationMs;
      stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);

      if (durationMs >= SCROLL_PERF_SLOW_SYNC_THRESHOLD_MS) {
        logForDebugging(
          `[scroll-perf] sync slow durationMs=${durationMs} messages=${props.messages.length} renderedEntries=${renderedEntries.length} totalRows=${totalRowCount}`,
          { level: "debug" }
        );
      } else {
        logForDebugging(`[scroll-perf] sync durationMs=${durationMs}`, { level: "verbose" });
      }

      const nowMs = Date.now();
      if (nowMs - stats.lastFlushAtMs < SCROLL_PERF_FLUSH_INTERVAL_MS) {
        return;
      }

      const averageMs = stats.sampleCount > 0
        ? Number((stats.totalDurationMs / stats.sampleCount).toFixed(2))
        : 0;
      logForDebugging(
        `[scroll-perf] sync aggregate samples=${stats.sampleCount} avgMs=${averageMs} maxMs=${stats.maxDurationMs} messages=${props.messages.length} renderedEntries=${renderedEntries.length} totalRows=${totalRowCount}`,
        { level: "debug" }
      );
      stats.sampleCount = 0;
      stats.totalDurationMs = 0;
      stats.maxDurationMs = 0;
      stats.lastFlushAtMs = nowMs;
    };

    syncScrollState();
    const timeout = setTimeout(syncScrollState, 0);
    const unsubscribe = handle.subscribe(syncScrollState);

    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [
    entryOffsets,
    props.messages.length,
    props.onNearTop,
    props.onStickyChange,
    renderedEntries,
    totalRowCount
  ]);

  useEffect(() => {
    if (!SCROLL_PERF_LOG_ENABLED) {
      return;
    }

    const nextSignature =
      `${props.messages.length}|${renderedEntries.length}|${totalRowCount}|${contentWidth}`;
    if (layoutPerfSignatureRef.current === nextSignature) {
      return;
    }

    layoutPerfSignatureRef.current = nextSignature;
    logForDebugging(
      `[scroll-perf] layout messageCount=${props.messages.length} renderedEntries=${renderedEntries.length} totalRows=${totalRowCount} contentWidth=${contentWidth}`,
      { level: "debug" }
    );
  }, [contentWidth, props.messages.length, renderedEntries.length, totalRowCount]);

  useEffect(() => {
    return () => {
      scrollDragOffsetRef.current = null;
      nearTopSnapshotRef.current = false;
      pendingPrependMessageIdsRef.current = [];
      if (scrollIndicatorTimeoutRef.current) {
        clearTimeout(scrollIndicatorTimeoutRef.current);
        scrollIndicatorTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const pendingIds = pendingPrependMessageIdsRef.current;
    if (pendingIds.length === 0) {
      return;
    }

    const rowCountById = new Map(
      renderedEntries.map((entry) => [entry.message.id, Math.max(1, entry.rowCount)] as const)
    );
    const addedRows = pendingIds.reduce(
      (sum, messageId) => sum + (rowCountById.get(messageId) ?? 0),
      0
    );
    pendingPrependMessageIdsRef.current = [];
    if (addedRows <= 0) {
      return;
    }

    scrollManuallyBy(addedRows);
  }, [renderedEntries]);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    const nextSignature = {
      contentWidth,
      messageCount: props.messages.length,
      totalRowCount
    };
    const previousSignature = layoutSignatureRef.current;
    layoutSignatureRef.current = nextSignature;

    if (props.messages.length === 0) {
      stickySnapshotRef.current = true;
      return;
    }

    if (!previousSignature) {
      if (handle.isSticky() || isHandleAtBottom(handle)) {
        handle.scrollToBottom();
      }
      return;
    }

    const viewportChanged = previousSignature.contentWidth !== nextSignature.contentWidth;
    const contentChanged =
      previousSignature.messageCount !== nextSignature.messageCount ||
      previousSignature.totalRowCount !== nextSignature.totalRowCount;

    if (!viewportChanged && !contentChanged) {
      return;
    }

    logLayoutTrace("message-list:layout-change", {
      previousContentWidth: previousSignature.contentWidth,
      nextContentWidth: nextSignature.contentWidth,
      previousMessages: previousSignature.messageCount,
      nextMessages: nextSignature.messageCount,
      previousRows: previousSignature.totalRowCount,
      nextRows: nextSignature.totalRowCount,
      viewportChanged,
      contentChanged,
      sticky: stickySnapshotRef.current,
      handleSticky: handle.isSticky(),
      isAtBottom: isHandleAtBottom(handle),
      scrollTop: handle.getScrollTop(),
      viewportHeight: handle.getViewportHeight(),
      scrollHeight: Math.max(handle.getScrollHeight(), handle.getFreshScrollHeight())
    });

    if (stickySnapshotRef.current || handle.isSticky() || isHandleAtBottom(handle)) {
      logLayoutTrace("message-list:resize-action", {
        action: "scrollToBottom",
        contentWidth,
        scrollTop: handle.getScrollTop()
      });
      handle.scrollToBottom();
      return;
    }

    if (viewportChanged) {
      // Resize after overlay close can leave ScrollBox viewport metrics one
      // frame behind. Trigger a no-op scroll mutation to force a fresh sync.
      logLayoutTrace("message-list:resize-action", {
        action: "scrollToSamePosition",
        contentWidth,
        scrollTop: handle.getScrollTop()
      });
      handle.scrollTo(handle.getScrollTop());
    }
  }, [contentWidth, props.messages.length, totalRowCount]);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle || !props.selectedMessageId) {
      selectedMessageSnapshotRef.current = props.selectedMessageId;
      return;
    }

    const selectedChanged = selectedMessageSnapshotRef.current !== props.selectedMessageId;
    selectedMessageSnapshotRef.current = props.selectedMessageId;
    if (!selectedChanged) {
      return;
    }

    const selectedIndex = renderedEntries.findIndex(
      (entry) => entry.message.id === props.selectedMessageId
    );
    if (selectedIndex < 0) {
      return;
    }

    const selectedEntry = renderedEntries[selectedIndex];
    if (!selectedEntry) {
      return;
    }

    const selectedTop = entryOffsets[selectedIndex] ?? 0;
    const selectedBottom = selectedTop + Math.max(1, selectedEntry.rowCount) - 1;
    const viewportHeight = Math.max(1, handle.getViewportHeight());
    const viewportTop = handle.getScrollTop();
    const viewportBottom = viewportTop + viewportHeight - 1;

    if (selectedTop < viewportTop) {
      handle.scrollTo(Math.max(0, selectedTop));
      return;
    }

    if (selectedBottom > viewportBottom) {
      handle.scrollTo(Math.max(0, selectedBottom - viewportHeight + 1));
    }
  }, [entryOffsets, props.selectedMessageId, renderedEntries]);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      width="100%"
      overflow="hidden"
    >
      <Box
        flexDirection="row"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        paddingX={1}
        width="100%"
      >
        <ScrollBox
          ref={scrollRef}
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          minWidth={0}
          // Keep the host sticky attribute stable. Manual scrollBy/scrollTo
          // already sets the imperative sticky flag to false, so toggling the
          // prop here only risks remount/reset churn when leaving the bottom.
          stickyScroll
        >
          <TranscriptRows
            renderedEntries={renderedEntries}
            virtualRange={virtualRange}
            unseenMessageCount={props.unseenMessageCount}
            showMessageTimestamps={props.showMessageTimestamps}
            onExpandableMessageClick={handleExpandableMessageClick}
          />
        </ScrollBox>
        <Box
          flexDirection="column"
          flexShrink={0}
          width={SCROLLBAR_WIDTH}
          marginLeft={1}
          noSelect
          onMouseDown={scrollIndicator.visible ? handleScrollbarMouseDown : undefined}
          onMouseMove={scrollIndicator.visible ? handleScrollbarMouseMove : undefined}
          onMouseUp={scrollIndicator.visible ? handleScrollbarMouseUp : undefined}
          onMouseEnter={scrollIndicator.visible ? activateScrollIndicator : undefined}
          onMouseLeave={scrollIndicator.visible
            ? () => {
                if (scrollDragOffsetRef.current === null) {
                  armScrollIndicatorFade();
                }
              }
            : undefined}
        >
          {scrollIndicatorLines.map((line) => (
            <Text
              key={line.key}
              color={line.color}
              dimColor={line.dimColor}
            >
              {line.char}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
});

export const MessageList = React.memo(MessageListImpl);
