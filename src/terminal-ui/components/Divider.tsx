import React from "react";
import { Text, useStdout } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

export function Divider(props: {
  char?: string;
  color?: string;
}) {
  const { stdout } = useStdout();
  const width = Math.max(1, stdout.columns || 80);

  return (
    <Text color={props.color ?? terminalUiTheme.colors.divider}>
      {(props.char ?? "─").repeat(width)}
    </Text>
  );
}
