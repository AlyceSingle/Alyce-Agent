import React from "react";
import { Box } from "../runtime/ink.js";

const SECTION_GAP_ROWS = 1;

function LayoutGap() {
  return <Box flexShrink={0} height={SECTION_GAP_ROWS} width="100%" />;
}

export function FullscreenLayout(props: {
  header?: React.ReactNode;
  transcript: React.ReactNode;
  pill?: React.ReactNode;
  overlay?: React.ReactNode;
  modal?: React.ReactNode;
  bottom?: React.ReactNode;
}) {
  const hasHeader = props.header !== undefined && props.header !== null;

  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      {hasHeader ? (
        <Box flexShrink={0} paddingX={1} width="100%">
          {props.header}
        </Box>
      ) : null}
      {hasHeader ? <LayoutGap /> : null}
      {props.modal !== undefined && props.modal !== null ? (
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          paddingX={1}
          width="100%"
        >
          {props.modal}
        </Box>
      ) : (
        <>
          <Box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            overflow="hidden"
            width="100%"
          >
            {props.transcript}
          </Box>
          {props.pill !== undefined && props.pill !== null ? (
            <Box flexShrink={0} paddingX={1} width="100%">
              {props.pill}
            </Box>
          ) : null}
          {props.overlay !== undefined && props.overlay !== null ? (
            <>
              <LayoutGap />
              <Box flexShrink={0} paddingX={1} paddingY={1} width="100%">
                {props.overlay}
              </Box>
            </>
          ) : null}
        </>
      )}
      {props.bottom !== undefined && props.bottom !== null && (props.modal === undefined || props.modal === null) ? (
        <>
          <LayoutGap />
          <Box flexShrink={0} paddingX={1} width="100%">
            {props.bottom}
          </Box>
        </>
      ) : null}
    </Box>
  );
}
