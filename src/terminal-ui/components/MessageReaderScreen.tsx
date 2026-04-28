import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildMarkdownRenderPlan,
  MarkdownRenderer,
  sliceMarkdownRenderPlan,
  shouldRenderMarkdownMessage
} from "./MarkdownRenderer.js";
import { Box, ScrollBox, Text, type ScrollBoxHandle } from "../runtime/ink.js";
import { useTerminalInput } from "../runtime/input.js";
import type { TerminalUiMessage } from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { wrapText } from "../utils/text.js";
import { Divider } from "./Divider.js";

const OVERSCAN_LINES = 3;
const MIN_VIEWPORT_ROWS = 6;

type ScrollSnapshot = {
  top: number;
  viewportHeight: number;
};

export function MessageReaderScreen(props: {
  message: TerminalUiMessage;
  terminalWidth: number;
  terminalHeight: number;
  markdownEnabled: boolean;
  onClose: () => void;
}) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const [scrollSnapshot, setScrollSnapshot] = useState<ScrollSnapshot>({
    top: 0,
    viewportHeight: Math.max(MIN_VIEWPORT_ROWS, props.terminalHeight - 8)
  });

  const contentWidth = Math.max(24, props.terminalWidth - 8);
  const markdownPlan = useMemo(() => {
    if (!shouldRenderMarkdownMessage(props.message.kind, props.markdownEnabled)) {
      return null;
    }

    return buildMarkdownRenderPlan(props.message.content, Math.max(16, contentWidth - 2));
  }, [contentWidth, props.markdownEnabled, props.message.content, props.message.kind]);
  const lines = useMemo(() => {
    if (markdownPlan) {
      return [];
    }

    const renderedLines: string[] = [];
    const blockWidth = Math.max(24, contentWidth - 4);

    for (let index = 0; index < props.message.blocks.length; index += 1) {
      const block = props.message.blocks[index]!;
      if (block.label) {
        renderedLines.push(block.label);
      }

      const wrapped = wrapText(block.content, block.style === "code" ? blockWidth - 2 : blockWidth);
      renderedLines.push(
        ...wrapped.map((line) => `${block.style === "code" ? "  " : ""}${line}`)
      );

      if (index < props.message.blocks.length - 1) {
        renderedLines.push("");
      }
    }

    return renderedLines.length > 0
      ? renderedLines
      : wrapText(props.message.content, Math.max(24, contentWidth - 2));
  }, [contentWidth, markdownPlan, props.message.blocks, props.message.content]);

  const syncScrollSnapshot = useCallback(() => {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    setScrollSnapshot({
      top: handle.getScrollTop(),
      viewportHeight: Math.max(MIN_VIEWPORT_ROWS, handle.getViewportHeight() || MIN_VIEWPORT_ROWS)
    });
  }, []);

  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) {
      return;
    }

    syncScrollSnapshot();
    const timeout = setTimeout(syncScrollSnapshot, 0);
    const unsubscribe = handle.subscribe(syncScrollSnapshot);

    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [props.message.id, syncScrollSnapshot]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0);
    const timeout = setTimeout(syncScrollSnapshot, 0);
    return () => {
      clearTimeout(timeout);
    };
  }, [props.message.id, syncScrollSnapshot]);

  useEffect(() => {
    const timeout = setTimeout(syncScrollSnapshot, 0);
    return () => {
      clearTimeout(timeout);
    };
  }, [props.terminalHeight, props.terminalWidth, syncScrollSnapshot]);

  useTerminalInput((input, key) => {
    const handle = scrollRef.current;
    if (!handle) {
      if (key.escape || (key.ctrl && input.toLowerCase() === "c") || input === "q") {
        props.onClose();
      }
      return;
    }

    const pageStep = Math.max(1, scrollSnapshot.viewportHeight - 2);

    if (key.escape || (key.ctrl && input.toLowerCase() === "c") || (!key.ctrl && !key.meta && input === "q")) {
      props.onClose();
      return;
    }

    if (key.upArrow) {
      handle.scrollBy(-1);
      return;
    }

    if (key.downArrow) {
      handle.scrollBy(1);
      return;
    }

    if (key.wheelUp) {
      handle.scrollBy(-3);
      return;
    }

    if (key.wheelDown) {
      handle.scrollBy(3);
      return;
    }

    if (key.pageUp) {
      handle.scrollBy(-pageStep);
      return;
    }

    if (key.pageDown || key.space || input === " ") {
      handle.scrollBy(pageStep);
      return;
    }

    if (key.home || (key.ctrl && input === "0")) {
      handle.scrollTo(0);
      return;
    }

    if (key.end) {
      handle.scrollToBottom();
    }
  }, { isActive: true });

  const viewportHeight = Math.max(MIN_VIEWPORT_ROWS, scrollSnapshot.viewportHeight);
  const totalLineCount = markdownPlan?.rowCount ?? lines.length;
  const visibleStart = Math.max(0, scrollSnapshot.top - OVERSCAN_LINES);
  const visibleEnd = Math.min(totalLineCount, scrollSnapshot.top + viewportHeight + OVERSCAN_LINES);
  const visibleLines = lines.slice(visibleStart, visibleEnd);
  const visibleMarkdownBlocks = markdownPlan
    ? sliceMarkdownRenderPlan(markdownPlan, visibleStart, visibleEnd)
    : null;
  const topSpacerHeight = visibleStart;
  const bottomSpacerHeight = Math.max(0, totalLineCount - visibleEnd);
  const lastVisibleLine =
    totalLineCount === 0 ? 0 : Math.min(totalLineCount, scrollSnapshot.top + viewportHeight);
  const metadataText = props.message.metadata.join(" | ") || "Full message";
  const badge =
    props.message.kind === "assistant"
      ? "ALYCE"
      : props.message.kind === "user"
        ? "USER"
        : props.message.kind === "tool"
          ? "TOOL"
          : props.message.kind === "thinking"
            ? "THINK"
            : props.message.kind === "error"
              ? "ERROR"
              : "SYSTEM";
  const badgeColor =
    props.message.kind === "user" || props.message.kind === "system"
      ? terminalUiTheme.colors.code
      : props.message.kind === "assistant"
        ? terminalUiTheme.colors.assistant
        : props.message.kind === "tool"
          ? terminalUiTheme.colors.tool
          : props.message.kind === "thinking"
            ? terminalUiTheme.colors.thinking
            : props.message.kind === "error"
            ? terminalUiTheme.colors.danger
              : terminalUiTheme.colors.code;
  const bodyColor =
    props.message.kind === "system"
      ? terminalUiTheme.colors.code
      : undefined;

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      paddingX={1}
      width="100%"
    >
      <Box flexShrink={0} width="100%">
        <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
          <Text color={badgeColor}>[{badge}]</Text>
          {" "}
          {props.message.title}
        </Text>
        <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
          {metadataText}
        </Text>
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          Reader mode | Esc / q / Ctrl+C close
        </Text>
        <Divider />
      </Box>
      <Box
        flexDirection="column"
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
          width="100%"
        >
          {markdownPlan ? (
            <>
              {topSpacerHeight > 0 ? <Box height={topSpacerHeight} /> : null}
              <MarkdownRenderer
                plan={{
                  blocks: visibleMarkdownBlocks ?? [],
                  rowCount: visibleEnd - visibleStart
                }}
                kind={props.message.kind}
              />
              {bottomSpacerHeight > 0 ? <Box height={bottomSpacerHeight} /> : null}
            </>
          ) : (
            <>
              {topSpacerHeight > 0 ? <Box height={topSpacerHeight} /> : null}
              {visibleLines.map((line, index) => (
                <Text
                  key={`${props.message.id}-${visibleStart + index}`}
                  color={line === "Input" || line === "Output" ? terminalUiTheme.colors.subtle : bodyColor}
                >
                  {line}
                </Text>
              ))}
              {bottomSpacerHeight > 0 ? <Box height={bottomSpacerHeight} /> : null}
            </>
          )}
        </ScrollBox>
      </Box>
      <Box flexShrink={0} width="100%">
        <Divider />
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          Lines {totalLineCount === 0 ? 0 : scrollSnapshot.top + 1}-{lastVisibleLine} of {totalLineCount}
          {" | "}
          Up/Down scroll
          {" | "}
          PgUp/PgDn jump
          {" | "}
          Home/End
          {" | "}
          Ctrl+0 top
        </Text>
      </Box>
    </Box>
  );
}
