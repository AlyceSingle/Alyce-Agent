import React from "react";
import Box from "../runtime/ink-runtime/components/Box.js";
import type { VirtualScrollRange } from "../hooks/useVirtualScroll.js";

export function VirtualMessageList<T>(props: {
  entries: readonly T[];
  range: VirtualScrollRange;
  renderEntry: (entry: T, index: number) => React.ReactNode;
}) {
  const visibleEntries = props.entries.slice(props.range.startIndex, props.range.endIndex);

  return (
    <Box flexDirection="column" width="100%" paddingBottom={1}>
      {props.range.topSpacerRows > 0 ? (
        <Box
          flexShrink={0}
          width="100%"
          height={props.range.topSpacerRows}
          noSelect="from-left-edge"
        />
      ) : null}
      {visibleEntries.map((entry, index) =>
        props.renderEntry(entry, props.range.startIndex + index)
      )}
      {props.range.bottomSpacerRows > 0 ? (
        <Box
          flexShrink={0}
          width="100%"
          height={props.range.bottomSpacerRows}
          noSelect="from-left-edge"
        />
      ) : null}
    </Box>
  );
}
