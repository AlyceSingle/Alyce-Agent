import React, { useCallback } from "react";
import { formatTime, t } from "../../../i18n/index.js";
import { MarkdownRenderer } from "../MarkdownRenderer.js";
import { VirtualMessageList } from "../VirtualMessageList.js";
import Box from "../../runtime/ink-runtime/components/Box.js";
import Text from "../../runtime/ink-runtime/components/Text.js";
import type { ClickEvent as TerminalClickEvent } from "../../runtime/ink-runtime/events/click-event.js";
import type { TerminalUiMessage } from "../../state/types.js";
import { terminalUiTheme } from "../../theme/theme.js";
import type { VirtualScrollRange } from "../../hooks/useVirtualScroll.js";
import {
  DIFF_LINE_NUMBER_LEFT_PADDING,
  getRenderedLineColors,
  shouldDisplaySectionLabel
} from "./sectionRendering.js";
import type { RenderedMessageEntry, ThemeColor } from "./messageListTypes.js";

const MESSAGE_RAIL_GUTTER = "│ ";
const MESSAGE_RAIL_GUTTER_WIDTH = MESSAGE_RAIL_GUTTER.length;

function SelectionSafeRow(props: React.ComponentProps<typeof Text>) {
  const { children, backgroundColor, ...textProps } = props;
  const rowBackgroundColor = backgroundColor as ThemeColor | undefined;

  return (
    <Box flexDirection="row" width="100%" backgroundColor={rowBackgroundColor}>
      <Text {...textProps} backgroundColor={backgroundColor}>{children}</Text>
      <Box flexGrow={1} noSelect backgroundColor={rowBackgroundColor} />
    </Box>
  );
}

export const TranscriptRows = React.memo(function TranscriptRows(props: {
  renderedEntries: RenderedMessageEntry[];
  virtualRange: VirtualScrollRange;
  unseenMessageCount: number;
  showMessageTimestamps: boolean;
  onExpandableMessageClick: (message: TerminalUiMessage, event: TerminalClickEvent) => void;
}) {
  const renderMessageEntry = useCallback((entry: RenderedMessageEntry) => {
    // 仅在设置 showMessageTimestamps 开启时计算/展示消息时钟，避免默认路径多余格式化。
    const timestamp = props.showMessageTimestamps
      ? formatTime(entry.message.createdAt)
      : null;
    const railRowCount = Math.max(
      1,
      entry.rowCount - entry.leadingSpacingRows - entry.unseenDividerRows
    );

    return (
      <Box
        key={entry.message.id}
        flexDirection="column"
        width="100%"
      >
        {Array.from({ length: entry.leadingSpacingRows }, (_, spacerIndex) => (
          <Box
            key={`${entry.message.id}-spacer-${spacerIndex}`}
            flexDirection="row"
            width="100%"
            noSelect="from-left-edge"
          >
            <Text> </Text>
          </Box>
        ))}
        {entry.unseenDividerRows > 0 ? (
          <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
            -- {props.unseenMessageCount} {props.unseenMessageCount === 1 ? t("messageList.newMessage") : t("messageList.newMessages")} --
          </Text>
        ) : null}
        <Box
          flexDirection="row"
          width="100%"
        >
          <Box
            flexDirection="column"
            flexShrink={0}
            width={MESSAGE_RAIL_GUTTER_WIDTH}
            noSelect="from-left-edge"
          >
            {Array.from({ length: railRowCount }, (_, rowIndex) => (
              <Text
                key={`${entry.message.id}-rail-${rowIndex}`}
                color={entry.palette.railColor}
                dimColor={!entry.isSelected}
              >
                {MESSAGE_RAIL_GUTTER}
              </Text>
            ))}
          </Box>
          <Box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            width="100%"
            onClick={entry.isExpandable
              ? (event) => props.onExpandableMessageClick(entry.message, event)
              : undefined}
          >
            <SelectionSafeRow wrap="truncate-end">
              {entry.headerSegments.map((segment, index) => (
                <Text key={`${entry.message.id}-header-${index}`} color={segment.color}>
                  {segment.text}
                </Text>
              ))}
              {timestamp ? (
                <Text color={entry.palette.mutedColor}> · {timestamp}</Text>
              ) : null}
            </SelectionSafeRow>
            {entry.markdownPlan ? (
              <MarkdownRenderer
                plan={entry.markdownPlan}
                kind={entry.message.kind}
                baseColor={entry.palette.bodyColor}
                colorMode={entry.message.kind === "tool" ? "plain" : "semantic"}
              />
            ) : (
              entry.sections.map((section, sectionIndex) => (
                <Box
                  key={`${entry.message.id}-section-${sectionIndex}`}
                  flexDirection="column"
                  width="100%"
                >
                  {shouldDisplaySectionLabel(section) ? (
                    <SelectionSafeRow
                      color={entry.palette.mutedColor}
                      wrap="truncate-end"
                    >
                      {section.label}
                    </SelectionSafeRow>
                  ) : null}
                  {section.lines.map((line, lineIndex) => {
                    const lineColors = getRenderedLineColors(
                      line,
                      section,
                      entry.message.kind,
                      entry.palette
                    );

                    return (
                      <SelectionSafeRow
                        key={`${entry.message.id}-line-${sectionIndex}-${lineIndex}`}
                        color={lineColors.color}
                        backgroundColor={lineColors.backgroundColor}
                      >
                        {line.lineNumberText !== undefined ? (
                          <Text
                            color={terminalUiTheme.colors.subtle}
                            backgroundColor={lineColors.backgroundColor}
                          >
                            {DIFF_LINE_NUMBER_LEFT_PADDING}{line.lineNumberText}{" "}
                          </Text>
                        ) : null}
                        {line.content || " "}
                      </SelectionSafeRow>
                    );
                  })}
                </Box>
              ))
            )}
            {entry.metadataLine ? (
              <SelectionSafeRow
                color={entry.palette.mutedColor}
                wrap="truncate-end"
              >
                {entry.metadataLine}
              </SelectionSafeRow>
            ) : null}
          </Box>
        </Box>
      </Box>
    );
  }, [props.onExpandableMessageClick, props.showMessageTimestamps, props.unseenMessageCount]);

  if (props.renderedEntries.length === 0) {
    return (
      <Box flexDirection="column" width="100%" paddingBottom={1}>
        <Text color={terminalUiTheme.colors.muted}>{t("messageList.empty")}</Text>
        <Text color={terminalUiTheme.colors.subtle}>
          {t("messageList.emptyHint")}
        </Text>
      </Box>
    );
  }

  return (
    <VirtualMessageList
      entries={props.renderedEntries}
      range={props.virtualRange}
      renderEntry={renderMessageEntry}
    />
  );
});
