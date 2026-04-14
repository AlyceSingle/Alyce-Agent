import React from "react";
import { Box } from "../runtime/ink.js";

export function Layout(props: {
  header: React.ReactNode;
  body?: React.ReactNode;
  footer?: React.ReactNode;
  overlay?: React.ReactNode;
}) {
  const hasFooterOrOverlay = Boolean(props.footer) || Boolean(props.overlay);

  return (
    <Box flexDirection="column" paddingX={1} width="100%" height="100%" flexGrow={1}>
      <Box marginBottom={1} width="100%" flexShrink={0}>
        {props.header}
      </Box>
      {props.body !== undefined && props.body !== null ? (
        <Box
          flexDirection="column"
          marginBottom={hasFooterOrOverlay ? 1 : 0}
          width="100%"
          flexGrow={1}
        >
          {props.body}
        </Box>
      ) : null}
      {props.footer !== undefined && props.footer !== null ? (
        <Box width="100%" flexShrink={0}>{props.footer}</Box>
      ) : null}
      {props.overlay ? (
        <Box marginTop={1} width="100%" flexShrink={0}>
          {props.overlay}
        </Box>
      ) : null}
    </Box>
  );
}
