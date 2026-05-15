import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  REPL_COMMAND_DEFINITIONS,
  type ReplCommandDefinition
} from "../../cli/commandRouter.js";
import { Box, Text, useTerminalSize } from "../runtime/ink.js";
import type { TerminalKey } from "../runtime/input.js";
import { logLayoutTrace } from "../runtime/utils/layoutTrace.js";
import { terminalUiTheme } from "../theme/theme.js";
import TextInput from "./TextInput.js";

const PROMPT_INPUT_VIEWPORT_OFFSET = 8;
const MAX_VISIBLE_SLASH_COMMAND_SUGGESTIONS = 10;

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

export function getVisibleSlashCommandSuggestions(
  suggestions: ReplCommandDefinition[],
  selectedIndex: number
) {
  const visibleCount = Math.min(MAX_VISIBLE_SLASH_COMMAND_SUGGESTIONS, suggestions.length);
  if (visibleCount === 0) {
    return {
      startIndex: 0,
      suggestions: []
    };
  }

  const safeSelectedIndex = Math.min(Math.max(0, selectedIndex), suggestions.length - 1);
  const startIndex = Math.min(
    Math.max(0, safeSelectedIndex - visibleCount + 1),
    suggestions.length - visibleCount
  );

  return {
    startIndex,
    suggestions: suggestions.slice(startIndex, startIndex + visibleCount)
  };
}

export function shouldCompleteSlashCommandInput(value: string, command: ReplCommandDefinition) {
  return value !== command.completion;
}

export function shouldToggleModeFromPromptKey(
  value: string,
  disabled: boolean,
  key: Pick<TerminalKey, "tab" | "shift" | "meta" | "ctrl">
) {
  return key.tab && !key.shift && !key.meta && !key.ctrl && !disabled && !isSlashCommandInput(value);
}

export function PromptInput(props: {
  value: string;
  viewportWidth: number;
  disabled: boolean;
  disabledReason?: string;
  sublineText?: string;
  onLayoutHeightChange?: () => void;
  onChange: (value: string) => void;
  onCtrlCCaptureChange: (capture: boolean) => void;
  onModeToggle?: () => Promise<void> | void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const terminalSize = useTerminalSize();
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const [escClearPending, setEscClearPending] = useState(false);
  const previousValueRef = useRef(props.value);
  const pendingLocalValueChangeRef = useRef(false);
  const pendingLocalCursorOffsetRef = useRef<number | null>(null);
  const layoutRowCountRef = useRef(0);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const viewportWidth = terminalSize.columns > 0 ? terminalSize.columns : props.viewportWidth;
  const inputColumns = Math.max(20, viewportWidth - PROMPT_INPUT_VIEWPORT_OFFSET);
  const slashSuggestions = useMemo(() => getSlashCommandSuggestions(props.value), [props.value]);
  const slashMenuVisible = !props.disabled && isSlashCommandInput(props.value) && slashSuggestions.length > 0;
  const layoutRowCount = slashMenuVisible
    ? Math.min(slashSuggestions.length, MAX_VISIBLE_SLASH_COMMAND_SUGGESTIONS) + 1
    : 0;
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
    const previousRowCount = layoutRowCountRef.current;
    if (previousRowCount === layoutRowCount) {
      return;
    }

    layoutRowCountRef.current = layoutRowCount;
    props.onLayoutHeightChange?.();
  }, [layoutRowCount, props.onLayoutHeightChange]);

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

  const handleInputKey = useCallback((_input: string, key: TerminalKey) => {
    if (shouldToggleModeFromPromptKey(props.value, props.disabled, key) && props.onModeToggle) {
      void props.onModeToggle();
      return true;
    }

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
    props.onModeToggle,
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
    <Box flexDirection="column" flexShrink={0} width="100%">
      {slashMenuVisible ? (
        <SlashCommandSuggestions
          suggestions={slashSuggestions}
          selectedIndex={Math.min(selectedSlashIndex, slashSuggestions.length - 1)}
        />
      ) : null}
      <Box
        flexDirection="column"
        flexShrink={0}
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
  const visibleSuggestions = getVisibleSlashCommandSuggestions(
    props.suggestions,
    props.selectedIndex
  );
  const usageWidth = Math.min(
    30,
    visibleSuggestions.suggestions.reduce((width, command) => Math.max(width, command.usage.length), 0)
  );

  return (
    <Box marginBottom={1} flexDirection="column" flexShrink={0} width="100%">
      {visibleSuggestions.suggestions.map((suggestion, index) => {
        const selected = visibleSuggestions.startIndex + index === props.selectedIndex;
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
