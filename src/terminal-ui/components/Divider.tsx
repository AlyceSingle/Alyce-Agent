import React from "react";
import { Text, useStdout } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

const DEFAULT_DIVIDER_CHAR = "-";
const SINGLE_WIDTH_ASCII_CHAR_PATTERN = /^[\x21-\x7E]$/;

export function Divider(props: {
  char?: string;
  color?: string;
}) {
  const { stdout } = useStdout();
  const width = Math.max(1, stdout.columns || 80);
  const char =
    props.char && SINGLE_WIDTH_ASCII_CHAR_PATTERN.test(props.char)
      ? props.char
      : DEFAULT_DIVIDER_CHAR;

  return (
    <Text color={props.color ?? terminalUiTheme.colors.divider} wrap="truncate-end">
      {char.repeat(width)}
    </Text>
  );
}
