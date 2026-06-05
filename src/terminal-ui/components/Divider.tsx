import Text from "../runtime/ink-runtime/components/Text.js";
import useTerminalSize from "../runtime/ink-runtime/hooks/use-terminal-size.js";
import { terminalUiTheme } from "../theme/theme.js";

const DEFAULT_DIVIDER_CHAR = "─";
const SINGLE_WIDTH_ASCII_CHAR_PATTERN = /^[\x21-\x7E]$/;

export function Divider(props: {
  char?: string;
  color?: string;
}) {
  const terminalSize = useTerminalSize();
  const width = Math.max(1, terminalSize.columns || 80);
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
