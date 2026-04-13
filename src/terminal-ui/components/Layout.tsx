import React from "react";
import { Box } from "../runtime/ink.js";

export function Layout(props: {
  header: React.ReactNode;
  body?: React.ReactNode;
  footer?: React.ReactNode;
  overlay?: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Box marginBottom={1} width="100%">
        {props.header}
      </Box>
      {props.body !== undefined && props.body !== null ? (
        <Box flexDirection="column" marginBottom={1} width="100%">
          {props.body}
        </Box>
      ) : null}
      {props.footer !== undefined && props.footer !== null ? (
        <Box width="100%">{props.footer}</Box>
      ) : null}
      {props.overlay ? <Box marginTop={1} width="100%">{props.overlay}</Box> : null}
    </Box>
  );
}
