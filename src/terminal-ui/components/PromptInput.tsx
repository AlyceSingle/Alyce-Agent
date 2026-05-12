import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  REPL_COMMAND_DEFINITIONS,
  type ReplCommandDefinition
} from "../../cli/commandRouter.js";
import { Box, Text, useStdout, useTerminalSize } from "../runtime/ink.js";
import type { TerminalKey } from "../runtime/input.js";
import { forceInkRedraw, invalidateInkPrevFrame } from "../runtime/instances.js";
import { logLayoutTrace } from "../runtime/utils/layoutTrace.js";
import { terminalUiTheme } from "../theme/theme.js";
import TextInput from "./TextInput.js";

const PROMPT_INPUT_VIEWPORT_OFFSET = 8;

export function isSlashCommandInput(value: string) {
  return value.startsWith("/") && !value.includes("\n");
}

export function getSlashCommandSuggestions(value: string): ReplCommandDefinition[] {
  if (!isSlashCommandInput(value)) {
    return [];
  }

  const query = value.toLowerCase();
  return REPL_COMMAND_DEFINITIONS.filter((command) => {
    const candidates = [command.command, command.usage, command.completion];
    return candidates.some((candidate) => candidate.toLowerCase().startsWith(query));
  });
}

export function shouldCompleteSlashCommandInput(value: string, command: ReplCommandDefinition) {
  return value !== command.completion;
}

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
  const terminalSize = useTerminalSize();
  const { stdout } = useStdout();
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const [escClearPending, setEscClearPending] = useState(false);
  const previousValueRef = useRef(props.value);
  const pendingLocalValueChangeRef = useRef(false);
  const pendingLocalCursorOffsetRef = useRef<number | null>(null);
  const slashMenuFrameRef = useRef({ visible: false, count: 0 });
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const viewportWidth = terminalSize.columns > 0 ? terminalSize.columns : props.viewportWidth;
  const inputColumns = Math.max(20, viewportWidth - PROMPT_INPUT_VIEWPORT_OFFSET);
  const slashSuggestions = useMemo(() => getSlashCommandSuggestions(props.value), [props.value]);
  const slashMenuVisible = !props.disabled && isSlashCommandInput(props.value) && slashSuggestions.length > 0;
  const selectedSlashSuggestion = slashSuggestions[Math.min(selectedSlashIndex, slashSuggestions.length - 1)];

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

  useLayoutEffect(() => {
    const previous = slashMenuFrameRef.current;
    const next = {
      visible: slashMenuVisible,
      count: slashMenuVisible ? slashSuggestions.length : 0
    };

    if (previous.visible === next.visible && previous.count === next.count) {
      return;
    }

    slashMenuFrameRef.current = next;
    const shrank = previous.visible && next.visible && next.count < previous.count;
    const closed = previous.visible && !next.visible;
    if (shrank || closed) {
      queueMicrotask(() => {
        forceInkRedraw(stdout as NodeJS.WriteStream);
      });
      return;
    }

    if (!previous.visible && next.visible) {
      invalidateInkPrevFrame(stdout as NodeJS.WriteStream);
    }
  }, [slashMenuVisible, slashSuggestions.length, stdout]);

  useEffect(() => {
    if (props.value.length === 0) {
      setEscClearPending(false);
    }
  }, [props.value.length]);

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [props.value]);

  useEffect(() => {
    if (slashSuggestions.length === 0) {
      setSelectedSlashIndex(0);
      return;
    }

    setSelectedSlashIndex((current) => Math.min(current, slashSuggestions.length - 1));
  }, [slashSuggestions.length]);

  useEffect(() => {
    logLayoutTrace("prompt-input:layout", {
      terminal: `${terminalSize.columns}x${terminalSize.rows}`,
      viewportWidth,
      columns: inputColumns,
      disabled: props.disabled,
      valueLength: props.value.length
    });
  }, [inputColumns, props.disabled, props.value.length, terminalSize.columns, terminalSize.rows, viewportWidth]);

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

  const applySlashCompletion = useCallback((command: ReplCommandDefinition) => {
    const nextValue = command.completion;
    handleChange(nextValue);
    handleCursorOffsetChange(nextValue.length);
    setEscClearPending(false);
  }, [handleChange, handleCursorOffsetChange]);

  const handleInputKey = useCallback((input: string, key: TerminalKey) => {
    const slashInputActive = !props.disabled && isSlashCommandInput(props.value);
    if (!slashInputActive) {
      return false;
    }

    if (slashSuggestions.length === 0) {
      return key.tab;
    }

    if (key.upArrow) {
      setSelectedSlashIndex((current) =>
        current <= 0 ? slashSuggestions.length - 1 : current - 1
      );
      return true;
    }

    if (key.downArrow) {
      setSelectedSlashIndex((current) => (current + 1) % slashSuggestions.length);
      return true;
    }

    if (key.tab) {
      if (selectedSlashSuggestion && shouldCompleteSlashCommandInput(props.value, selectedSlashSuggestion)) {
        applySlashCompletion(selectedSlashSuggestion);
      }
      return true;
    }

    if (key.return && !key.shift && !key.meta && !key.ctrl && selectedSlashSuggestion) {
      if (shouldCompleteSlashCommandInput(props.value, selectedSlashSuggestion)) {
        applySlashCompletion(selectedSlashSuggestion);
        return true;
      }
    }

    return false;
  }, [
    applySlashCompletion,
    props.disabled,
    props.value,
    selectedSlashSuggestion,
    slashSuggestions.length
  ]);

  const statusHint = props.disabled
    ? props.disabledReason || "Input locked."
    : escClearPending
      ? "Press Esc again to clear input."
      : props.sublineText;

  return (
    <Box flexDirection="column" width="100%">
      {slashMenuVisible ? (
        <SlashCommandSuggestions
          suggestions={slashSuggestions}
          selectedIndex={Math.min(selectedSlashIndex, slashSuggestions.length - 1)}
        />
      ) : null}
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
          onInputKey={handleInputKey}
          focus={!props.disabled}
          multiline
          showCursor={!props.disabled}
          columns={inputColumns}
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

function SlashCommandSuggestions(props: {
  suggestions: ReplCommandDefinition[];
  selectedIndex: number;
}) {
  const usageWidth = Math.min(
    30,
    props.suggestions.reduce((width, command) => Math.max(width, command.usage.length), 0)
  );

  return (
    <Box marginBottom={1} flexDirection="column" width="100%">
      {props.suggestions.map((suggestion, index) => {
        const selected = index === props.selectedIndex;
        const marker = selected ? "› " : "  ";
        const color = selected ? terminalUiTheme.colors.promptAccent : terminalUiTheme.colors.inputTray;
        return (
          <Text
            key={suggestion.usage}
            color={color}
            wrap="truncate-end"
          >
            {marker}
            {suggestion.usage.padEnd(usageWidth)}
            {"  "}
            <Text color={selected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.subtle}>
              {suggestion.description}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
