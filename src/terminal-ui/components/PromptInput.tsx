import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  REPL_COMMAND_DEFINITIONS,
  type ReplCommandDefinition
} from "../../cli/commandRouter.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useTerminalSize from "../runtime/ink-runtime/hooks/use-terminal-size.js";
import type { TerminalKey } from "../runtime/input.js";
import { logLayoutTrace } from "../runtime/utils/layoutTrace.js";
import { t } from "../../i18n/index.js";
import { terminalUiTheme } from "../theme/theme.js";
import { useSelection } from "../runtime/ink-runtime/hooks/use-selection.js";
import TextInput from "./TextInput.js";

const PROMPT_INPUT_VIEWPORT_OFFSET = 8;
const MAX_VISIBLE_SLASH_COMMAND_SUGGESTIONS = 10;

export function getInputLockedPlaceholder(): string {
  return t("promptInput.placeholder.locked");
}

const SLASH_COMMAND_SEARCH_INDEX = REPL_COMMAND_DEFINITIONS.map((command) => ({
  command,
  prefixes: Array.from(
    new Set(
      [
        command.command,
        command.usage,
        command.completion,
        ...(command.searchPrefixes ?? [])
      ].map((candidate) => candidate.toLowerCase())
    )
  )
}));

export function isSlashCommandInput(value: string) {
  return value.startsWith("/") && !value.includes("\n");
}

export function getSlashCommandSuggestions(value: string): ReplCommandDefinition[] {
  if (!isSlashCommandInput(value)) {
    return [];
  }

  const query = value.toLowerCase();
  const matches: ReplCommandDefinition[] = [];
  for (const entry of SLASH_COMMAND_SEARCH_INDEX) {
    if (entry.prefixes.some((prefix) => prefix.startsWith(query))) {
      matches.push(entry.command);
    }
  }
  return matches;
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

export function resolvePromptPlaceholderState(options: {
  disabled: boolean;
  disabledPlaceholder?: string;
}) {
  const useDisabledPlaceholder =
    options.disabled &&
    options.disabledPlaceholder !== undefined &&
    options.disabledPlaceholder.trim().length > 0;

  return {
    text: useDisabledPlaceholder ? options.disabledPlaceholder! : t("promptInput.placeholder.default"),
    color: useDisabledPlaceholder
      ? terminalUiTheme.colors.warning
      : terminalUiTheme.colors.inputPlaceholder,
    dimColor: !useDisabledPlaceholder
  };
}

export function PromptInput(props: {
  value: string;
  viewportWidth: number;
  disabled: boolean;
  disabledReason?: string;
  disabledPlaceholder?: string;
  sublineText?: string;
  onLayoutHeightChange?: () => void;
  onChange: (value: string) => void;
  onCtrlCCaptureChange: (capture: boolean) => void;
  onModeToggle?: () => Promise<void> | void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const terminalSize = useTerminalSize();
  const selection = useSelection();
  // 输入值先落本地 state，避免每键都等全局 store 回传才刷新光标/文本。
  const [localValue, setLocalValue] = useState(props.value);
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const [escClearPending, setEscClearPending] = useState(false);
  const lastExternalValueRef = useRef(props.value);
  const pendingStoreSyncRef = useRef<string | null>(null);
  const storeSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutRowCountRef = useRef(0);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const viewportWidth = terminalSize.columns > 0 ? terminalSize.columns : props.viewportWidth;
  const inputColumns = Math.max(20, viewportWidth - PROMPT_INPUT_VIEWPORT_OFFSET);
  const slashSuggestions = useMemo(() => getSlashCommandSuggestions(localValue), [localValue]);
  const slashMenuVisible = !props.disabled && isSlashCommandInput(localValue) && slashSuggestions.length > 0;
  const layoutRowCount = slashMenuVisible
    ? Math.min(slashSuggestions.length, MAX_VISIBLE_SLASH_COMMAND_SUGGESTIONS) + 1
    : 0;
  const selectedSlashSuggestion = slashSuggestions[Math.min(selectedSlashIndex, slashSuggestions.length - 1)];

  const flushStoreSync = useCallback(() => {
    storeSyncTimerRef.current = null;
    const pending = pendingStoreSyncRef.current;
    if (pending === null) {
      return;
    }
    pendingStoreSyncRef.current = null;
    // 标记为本地回写，避免 props 回传时重置光标。
    lastExternalValueRef.current = pending;
    props.onChange(pending);
  }, [props.onChange]);

  useEffect(() => {
    props.onCtrlCCaptureChange(!props.disabled && localValue.length > 0);
  }, [props.disabled, props.onCtrlCCaptureChange, localValue.length]);

  // 外部写入 draft（恢复会话、提交清空、Ctrl+C 清空）时同步本地缓冲。
  useEffect(() => {
    if (props.value === lastExternalValueRef.current) {
      return;
    }

    lastExternalValueRef.current = props.value;
    pendingStoreSyncRef.current = null;
    if (storeSyncTimerRef.current !== null) {
      clearTimeout(storeSyncTimerRef.current);
      storeSyncTimerRef.current = null;
    }
    setLocalValue(props.value);
    setCursorOffset(props.value.length);
  }, [props.value]);

  // 值缩短后夹紧光标，避免 offset 悬空导致光标块不绘制。
  useEffect(() => {
    setCursorOffset((current) => (current <= localValue.length ? current : localValue.length));
  }, [localValue]);

  useEffect(() => {
    return () => {
      if (storeSyncTimerRef.current !== null) {
        clearTimeout(storeSyncTimerRef.current);
      }
    };
  }, []);

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
    if (localValue.length === 0) {
      setEscClearPending(false);
    }
  }, [localValue.length]);

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [localValue]);

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
      valueLength: localValue.length
    });
  }, [inputColumns, localValue.length, props.disabled, terminalSize.columns, terminalSize.rows, viewportWidth]);

  const handleChange = useCallback((value: string) => {
    // 粘贴/编辑时清掉 transcript selection，避免高亮盖住输入光标，也避免 Ctrl+C 被“复制选区”劫持。
    if (selection.hasSelection()) {
      selection.clearSelection();
    }
    const previousLocalValue = localValue;
    setLocalValue(value);
    pendingStoreSyncRef.current = value;
    // 空/非空切换、粘贴/多行立刻同步，保证 Ctrl+C 读 store 与本地一致；单字编辑合并到下一 macrotask。
    const emptinessChanged =
      (lastExternalValueRef.current.length === 0) !== (value.length === 0);
    const looksLikePaste =
      Math.abs(value.length - previousLocalValue.length) > 1 ||
      value.includes("\n") ||
      previousLocalValue.includes("\n") !== value.includes("\n");
    if (emptinessChanged || looksLikePaste) {
      if (storeSyncTimerRef.current !== null) {
        clearTimeout(storeSyncTimerRef.current);
        storeSyncTimerRef.current = null;
      }
      flushStoreSync();
      return;
    }
    if (storeSyncTimerRef.current === null) {
      storeSyncTimerRef.current = setTimeout(flushStoreSync, 0);
    }
  }, [flushStoreSync, localValue, selection]);

  const handleCursorOffsetChange = useCallback((offset: number) => {
    setCursorOffset(offset);
  }, []);

  const applySlashCompletion = useCallback((command: ReplCommandDefinition) => {
    const nextValue = command.completion;
    handleChange(nextValue);
    handleCursorOffsetChange(nextValue.length);
    setEscClearPending(false);
  }, [handleChange, handleCursorOffsetChange]);

  const handleInputKey = useCallback((_input: string, key: TerminalKey) => {
    if (shouldToggleModeFromPromptKey(localValue, props.disabled, key) && props.onModeToggle) {
      void props.onModeToggle();
      return true;
    }

    const slashInputActive = !props.disabled && isSlashCommandInput(localValue);
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
      if (selectedSlashSuggestion && shouldCompleteSlashCommandInput(localValue, selectedSlashSuggestion)) {
        applySlashCompletion(selectedSlashSuggestion);
      }
      return true;
    }

    if (key.return && !key.shift && !key.meta && !key.ctrl && selectedSlashSuggestion) {
      if (shouldCompleteSlashCommandInput(localValue, selectedSlashSuggestion)) {
        applySlashCompletion(selectedSlashSuggestion);
        return true;
      }
    }

    return false;
  }, [
    applySlashCompletion,
    localValue,
    props.disabled,
    props.onModeToggle,
    selectedSlashSuggestion,
    slashSuggestions.length
  ]);

  const hasDisabledReason = props.disabled && props.disabledReason !== undefined;
  const statusHint = hasDisabledReason
    ? props.disabledReason
    : !props.disabled && escClearPending
      ? t("promptInput.hint.escClear")
      : props.sublineText;
  const placeholderState = resolvePromptPlaceholderState({
    disabled: props.disabled,
    disabledPlaceholder: props.disabledPlaceholder
  });

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
          value={localValue}
          onChange={handleChange}
          onSubmit={(value) => {
            // 提交后立即清空本地缓冲。不能只写 lastExternalValueRef=value：
            // dock 的 props.value 往往仍是 ""，effect 不会触发，输入框会残留文字。
            if (storeSyncTimerRef.current !== null) {
              clearTimeout(storeSyncTimerRef.current);
              storeSyncTimerRef.current = null;
            }
            pendingStoreSyncRef.current = null;
            setLocalValue("");
            setCursorOffset(0);
            lastExternalValueRef.current = "";
            props.onChange("");
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
          placeholder={placeholderState.text}
          firstLinePrefix="› "
          continuationPrefix="  "
          prefixColor={props.disabled ? terminalUiTheme.colors.muted : terminalUiTheme.colors.promptAccent}
          placeholderColor={placeholderState.color}
          placeholderDimColor={placeholderState.dimColor}
          overflowHintColor={terminalUiTheme.colors.promptMuted}
        />
        {statusHint ? (
          <Box marginTop={1} width="100%">
            <Text
              color={hasDisabledReason ? terminalUiTheme.colors.warning : terminalUiTheme.colors.inputTray}
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
  const commandWidth = Math.min(
    30,
    visibleSuggestions.suggestions.reduce((width, command) => Math.max(width, command.command.length), 0)
  );

  return (
    <Box marginBottom={1} flexDirection="column" flexShrink={0} width="100%">
      {visibleSuggestions.suggestions.map((suggestion, index) => {
        const selected = visibleSuggestions.startIndex + index === props.selectedIndex;
        const marker = selected ? "› " : "  ";
        const color = selected ? terminalUiTheme.colors.promptAccent : terminalUiTheme.colors.inputTray;
        return (
          <Text
            key={suggestion.command}
            color={color}
            wrap="truncate-end"
          >
            {marker}
            {suggestion.command.padEnd(commandWidth)}
            {"  "}
            <Text color={selected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.subtle}>
              {t(suggestion.descriptionKey)}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
