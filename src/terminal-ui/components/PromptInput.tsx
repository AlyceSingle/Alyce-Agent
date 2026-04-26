import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import TextInput from "./TextInput.js";

export function PromptInput(props: {
  value: string;
  viewportWidth: number;
  disabled: boolean;
  disabledReason?: string;
  sublineText?: string;
  onChange: (value: string) => void;
  onCtrlCCaptureChange: (capture: boolean) => void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const [escClearPending, setEscClearPending] = useState(false);
  const previousValueRef = useRef(props.value);
  const pendingLocalValueChangeRef = useRef(false);
  const pendingLocalCursorOffsetRef = useRef<number | null>(null);

  useEffect(() => {
    props.onCtrlCCaptureChange(!props.disabled && props.value.length > 0);
  }, [props.disabled, props.onCtrlCCaptureChange, props.value]);

  useEffect(() => {
    const previousValue = previousValueRef.current;
    previousValueRef.current = props.value;

    if (previousValue === props.value) {
      return;
    }

    if (pendingLocalValueChangeRef.current) {
      pendingLocalValueChangeRef.current = false;
      const pendingLocalCursorOffset = pendingLocalCursorOffsetRef.current;
      pendingLocalCursorOffsetRef.current = null;

      if (pendingLocalCursorOffset !== null) {
        setCursorOffset((current) => {
          const nextCursorOffset = Math.min(props.value.length, pendingLocalCursorOffset);
          return current === nextCursorOffset ? current : nextCursorOffset;
        });
      }
      return;
    }

    pendingLocalCursorOffsetRef.current = null;
    setCursorOffset(props.value.length);
  }, [props.value]);

  useEffect(() => {
    return () => {
      props.onCtrlCCaptureChange(false);
    };
  }, [props.onCtrlCCaptureChange]);

  useEffect(() => {
    if (!props.disabled) {
      return;
    }

    setEscClearPending(false);
  }, [props.disabled]);

  useEffect(() => {
    if (props.value.length === 0) {
      setEscClearPending(false);
    }
  }, [props.value.length]);

  const handleChange = useCallback((value: string) => {
    pendingLocalValueChangeRef.current = true;
    props.onChange(value);
  }, [props.onChange]);

  const handleCursorOffsetChange = useCallback((offset: number) => {
    if (pendingLocalValueChangeRef.current) {
      pendingLocalCursorOffsetRef.current = offset;
    }

    setCursorOffset(offset);
  }, []);

  const statusHint = props.disabled
    ? props.disabledReason || "Input locked."
    : escClearPending
      ? "Press Esc again to clear input."
      : props.sublineText;

  return (
    <Box flexDirection="column" width="100%">
      <TextInput
        value={props.value}
        onChange={handleChange}
        onSubmit={(value) => {
          void props.onSubmit(value);
        }}
        focus={!props.disabled}
        multiline
        showCursor={!props.disabled}
        columns={Math.max(20, props.viewportWidth - 2)}
        maxVisibleLines={4}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={handleCursorOffsetChange}
        onEscClearPendingChange={setEscClearPending}
        placeholder="Ask Alyce to inspect, edit, or explain something..."
      />
      {statusHint ? (
        <Text
          color={props.disabled ? terminalUiTheme.colors.warning : terminalUiTheme.colors.subtle}
          wrap="truncate-end"
        >
          {statusHint}
        </Text>
      ) : null}
    </Box>
  );
}
