import React, { useEffect } from "react";
import { useTerminalSize } from "../runtime/ink.js";
import { logLayoutTrace } from "../runtime/utils/layoutTrace.js";
import { useTextInput } from "../hooks/useTextInput.js";
import type { BaseTextInputProps } from "../types/textInputTypes.js";
import { BaseTextInput } from "./BaseTextInput.js";

export default function TextInput(props: BaseTextInputProps): React.ReactNode {
  const terminalSize = useTerminalSize();
  const columns = props.columns || terminalSize.columns || 80;
  const textInputState = useTextInput({
    value: props.value,
    onChange: props.onChange,
    onSubmit: props.onSubmit,
    multiline: props.multiline,
    columns,
    maxVisibleLines: props.maxVisibleLines,
    cursorOffset: props.cursorOffset,
    onChangeCursorOffset: props.onChangeCursorOffset,
    onEscClearPendingChange: props.onEscClearPendingChange,
    firstLinePrefix: props.firstLinePrefix,
    continuationPrefix: props.continuationPrefix
  });

  useEffect(() => {
    logLayoutTrace("text-input:state", {
      terminal: `${terminalSize.columns}x${terminalSize.rows}`,
      columns,
      valueLength: props.value.length,
      lines: textInputState.lines.length,
      cursorLine: textInputState.cursorLine,
      cursorColumn: textInputState.cursorColumn,
      topOverflow: textInputState.hasTopOverflow,
      bottomOverflow: textInputState.hasBottomOverflow
    });
  }, [
    columns,
    props.value.length,
    terminalSize.columns,
    terminalSize.rows,
    textInputState.cursorColumn,
    textInputState.cursorLine,
    textInputState.hasBottomOverflow,
    textInputState.hasTopOverflow,
    textInputState.lines.length
  ]);

  return (
    <BaseTextInput
      {...props}
      inputState={textInputState}
      terminalFocus
    />
  );
}
