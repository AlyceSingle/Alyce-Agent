import { useDeclaredCursor } from "../runtime/useDeclaredCursor.js";
import { Box, Text } from "../runtime/ink.js";
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
  const cursorRef = useDeclaredCursor({
    line: inputState.cursorLine,
    column: inputState.cursorColumn,
    active: Boolean(props.focus && props.showCursor && props.terminalFocus)
  });

  useTerminalInput(inputState.onInput, {
    isActive: props.focus
  });

  return (
    <Box ref={cursorRef} flexDirection="column" width="100%">
      {inputState.hasTopOverflow ? (
        <Text color={overflowHintColor} dimColor>... earlier lines</Text>
      ) : null}
      {props.value.length === 0 ? (
        <Text>
          <Text color={prefixColor}>{firstLinePrefix}</Text>
          {props.showCursor ? <Text inverse>{" "}</Text> : null}
          <Text color={placeholderColor} dimColor>
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
      {inputState.hasBottomOverflow ? (
        <Text color={overflowHintColor} dimColor>... more lines below</Text>
      ) : null}
    </Box>
  );
}
