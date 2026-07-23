import { useDeclaredCursor } from "../runtime/useDeclaredCursor.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import { useTerminalInput } from "../runtime/input.js";
import type { BaseInputState, BaseTextInputProps } from "../types/textInputTypes.js";
import { terminalUiTheme } from "../theme/theme.js";

export function BaseTextInput(props: BaseTextInputProps & {
  inputState: BaseInputState;
  terminalFocus: boolean;
}) {
  const { inputState } = props;
  const firstLinePrefix = props.firstLinePrefix ?? "> ";
  const continuationPrefix = props.continuationPrefix ?? "  ";
  const prefixColor = props.prefixColor ?? terminalUiTheme.colors.promptAccent;
  const placeholderColor = props.placeholderColor ?? terminalUiTheme.colors.selectionMuted;
  const overflowHintColor = props.overflowHintColor ?? terminalUiTheme.colors.promptMuted;
  const topChromeRows =
    inputState.reserveOverflowChrome || inputState.hasTopOverflow ? 1 : 0;
  const cursorRef = useDeclaredCursor({
    // 顶部溢出提示占一行时，声明光标行要整体下移，否则会偏到上一行导致跳动。
    line: inputState.cursorLine + topChromeRows,
    column: inputState.cursorColumn,
    active: Boolean(props.focus && props.showCursor && props.terminalFocus)
  });

  useTerminalInput(inputState.onInput, {
    isActive: props.focus
  });

  return (
    <Box ref={cursorRef} flexDirection="column" width="100%">
      {inputState.reserveOverflowChrome || inputState.hasTopOverflow ? (
        <Text color={overflowHintColor} dimColor>
          {inputState.hasTopOverflow ? "... earlier lines" : " "}
        </Text>
      ) : null}
      {props.value.length === 0 ? (
        <Text>
          <Text color={prefixColor}>{firstLinePrefix}</Text>
          {props.showCursor ? <Text inverse>{" "}</Text> : null}
          <Text color={placeholderColor} dimColor={props.placeholderDimColor ?? true}>
            {props.placeholder ?? ""}
          </Text>
        </Text>
      ) : (
        inputState.lines.map((line, index) => (
          <Text key={`text-input-line-${index}`}>
            <Text color={prefixColor}>{index === 0 ? firstLinePrefix : continuationPrefix}</Text>
            <Text>{line.before}</Text>
            {line.isCursorLine && line.current !== null ? (
              <Text inverse>{line.current}</Text>
            ) : null}
            <Text>{line.after}</Text>
          </Text>
        ))
      )}
      {inputState.reserveOverflowChrome || inputState.hasBottomOverflow ? (
        <Text color={overflowHintColor} dimColor>
          {inputState.hasBottomOverflow ? "... more lines below" : " "}
        </Text>
      ) : null}
    </Box>
  );
}
