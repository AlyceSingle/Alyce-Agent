import React from "react";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

export function Pane(props: {
  title: string;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  accentColor?: string;
  children?: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" width="100%">
      <Text color={props.accentColor ?? terminalUiTheme.colors.chrome} wrap="truncate-end">
        {props.title}
      </Text>
      {props.subtitle !== undefined && props.subtitle !== null ? (
        <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
          {props.subtitle}
        </Text>
      ) : null}
      {props.children !== undefined && props.children !== null ? (
        <Box flexDirection="column" marginTop={1} width="100%">
          {props.children}
        </Box>
      ) : null}
      {props.footer !== undefined && props.footer !== null ? (
        <Box marginTop={1} width="100%">
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            {props.footer}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
