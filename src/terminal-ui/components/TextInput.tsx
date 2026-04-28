import React from "react";
import { useStdout } from "../runtime/ink.js";
import { useTextInput } from "../hooks/useTextInput.js";
import type { BaseTextInputProps } from "../types/textInputTypes.js";
import { BaseTextInput } from "./BaseTextInput.js";

export default function TextInput(props: BaseTextInputProps): React.ReactNode {
  const { stdout } = useStdout();
  const textInputState = useTextInput({
    value: props.value,
    onChange: props.onChange,
    onSubmit: props.onSubmit,
    multiline: props.multiline,
    columns: props.columns || stdout.columns || 80,
    maxVisibleLines: props.maxVisibleLines,
    cursorOffset: props.cursorOffset,
    onChangeCursorOffset: props.onChangeCursorOffset,
    onEscClearPendingChange: props.onEscClearPendingChange,
    firstLinePrefix: props.firstLinePrefix,
    continuationPrefix: props.continuationPrefix
  });

  return (
    <BaseTextInput
      {...props}
      inputState={textInputState}
      terminalFocus
    />
  );
}
