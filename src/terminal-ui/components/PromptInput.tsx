import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import TextInput from "./TextInput.js";

const PROMPT_INPUT_VIEWPORT_OFFSET = 8;

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
      <Box
        flexDirection="column"
        width="100%"
        borderStyle="round"
        borderColor={terminalUiTheme.colors.inputBorder}
        borderLeftColor={props.disabled ? terminalUiTheme.colors.warning : terminalUiTheme.colors.promptAccent}
        borderDimColor={props.disabled}
        paddingX={1}
      >
        <TextInput
          value={props.value}
          onChange={handleChange}
          onSubmit={(value) => {
            void props.onSubmit(value);
          }}
          focus={!props.disabled}
          multiline
          showCursor={!props.disabled}
          columns={Math.max(20, props.viewportWidth - PROMPT_INPUT_VIEWPORT_OFFSET)}
          maxVisibleLines={4}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={handleCursorOffsetChange}
          onEscClearPendingChange={setEscClearPending}
          placeholder="Ask Alyce to inspect, edit, or explain something..."
          firstLinePrefix="› "
          continuationPrefix="  "
          prefixColor={props.disabled ? terminalUiTheme.colors.muted : terminalUiTheme.colors.promptAccent}
          placeholderColor={terminalUiTheme.colors.inputPlaceholder}
          overflowHintColor={terminalUiTheme.colors.promptMuted}
        />
        {statusHint ? (
          <Box marginTop={1} width="100%">
            <Text
              color={props.disabled ? terminalUiTheme.colors.warning : terminalUiTheme.colors.inputTray}
              wrap="truncate-end"
            >
              {statusHint}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
