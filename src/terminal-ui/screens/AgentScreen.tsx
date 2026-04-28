import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useStdout, Text } from "../runtime/ink.js";
import { FullscreenLayout } from "../components/FullscreenLayout.js";
import { MessageList, type MessageListHandle } from "../components/MessageList.js";
import { MessageReaderScreen } from "../components/MessageReaderScreen.js";
import { PromptInput } from "../components/PromptInput.js";
import { StatusBar } from "../components/StatusBar.js";
import { TodoPanel } from "../components/TodoPanel.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { AskUserQuestionDialog } from "../components/AskUserQuestionDialog.js";
import { SettingsDialog } from "../components/SettingsDialog.js";
import { SessionPickerDialog } from "../components/SessionPickerDialog.js";
import { RewindPickerDialog } from "../components/RewindPickerDialog.js";
import type { SessionController } from "../adapters/sessionController.js";
import { useIsOverlayActive } from "../context/overlayContext.js";
import { useKeybindings } from "../keybindings/useKeybindings.js";
import { getBindingDisplayText } from "../keybindings/shortcutDisplay.js";
import { useSelection } from "../runtime/ink-runtime/hooks/use-selection.js";
import { setClipboard } from "../runtime/ink-runtime/termio/osc.js";
import { useTerminalInput } from "../runtime/input.js";
import { getActiveDialog, selectRelativeMessage, setTranscriptSticky } from "../state/actions.js";
import { useTerminalUiSelector, useTerminalUiStore } from "../state/store.js";
import { terminalUiTheme } from "../theme/theme.js";

const EXIT_CONFIRMATION_STATUS = "Press Ctrl+C again to quit";
const COPY_STATUS_DURATION_MS = 1800;
const OPEN_DETAIL_SHORTCUT = getBindingDisplayText("conversation:openDetail", "Global") ?? "Ctrl+O";
const PAGE_UP_SHORTCUT = getBindingDisplayText("scroll:pageUp", "Scroll") ?? "PgUp";
const PAGE_DOWN_SHORTCUT = getBindingDisplayText("scroll:pageDown", "Scroll") ?? "PgDn";
const LAST_MESSAGE_SHORTCUT = getBindingDisplayText("scroll:bottom", "Scroll") ?? "End";
const LINE_SCROLL_ROWS = 2;

const ConversationPane = React.memo(React.forwardRef<MessageListHandle, {
  terminalWidth: number;
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  onStickyChange: (sticky: boolean) => void;
}>(function ConversationPane(props, ref) {
  const messages = useTerminalUiSelector((value) => value.messages);
  const selectedMessageId = useTerminalUiSelector((value) => value.selectedMessageId);
  const markdownEnabled = useTerminalUiSelector(
    (value) => value.settings.markdownMessageRenderingEnabled
  );

  return (
    <MessageList
      ref={ref}
      messages={messages}
      selectedMessageId={selectedMessageId}
      viewportWidth={props.terminalWidth}
      markdownEnabled={markdownEnabled}
      unseenDividerMessageId={props.unseenDividerMessageId}
      unseenMessageCount={props.unseenMessageCount}
      onStickyChange={props.onStickyChange}
    />
  );
}));

export function AgentScreen(props: { controller: SessionController }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const selection = useSelection();
  const store = useTerminalUiStore();
  const dialogQueue = useTerminalUiSelector((value) => value.dialogQueue);
  const connection = useTerminalUiSelector((value) => value.connection);
  const connectionState = useTerminalUiSelector((value) => value.connectionState);
  const settings = useTerminalUiSelector((value) => value.settings);
  const settingsState = useTerminalUiSelector((value) => value.settingsState);
  const workspaceRoot = useTerminalUiSelector((value) => value.workspaceRoot);
  const sessionApprovalMode = useTerminalUiSelector((value) => value.sessionApprovalMode);
  const sessionAllowedKinds = useTerminalUiSelector((value) => value.sessionAllowedKinds);
  const requestPatchCount = useTerminalUiSelector((value) => value.requestPatchCount);
  const statusText = useTerminalUiSelector((value) => value.statusText);
  const isLoading = useTerminalUiSelector((value) => value.isLoading);
  const draftInput = useTerminalUiSelector((value) => value.draftInput);
  const todos = useTerminalUiSelector((value) => value.todos);
  const selectedMessageId = useTerminalUiSelector((value) => value.selectedMessageId);
  const transcriptSticky = useTerminalUiSelector((value) => value.transcriptSticky);
  const unseenDividerMessageId = useTerminalUiSelector((value) => value.unseenDividerMessageId);
  const unseenMessageCount = useTerminalUiSelector((value) => value.unseenMessageCount);
  const messages = useTerminalUiSelector((value) => value.messages);
  const clearOnCtrlCRef = useRef(false);
  const transcriptRef = useRef<MessageListHandle | null>(null);
  const copyStatusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [copyStatusText, setCopyStatusText] = useState<string | null>(null);
  const [exitConfirmationPending, setExitConfirmationPending] = useState(false);
  const terminalWidth = stdout.columns || 120;
  const terminalHeight = stdout.rows || 36;
  const activeDialog = dialogQueue[0] ?? null;
  const hasDialog = activeDialog !== null;
  const isReaderOpen = activeDialog?.type === "reader";
  const hasActiveOverlay = useIsOverlayActive();

  const readerMessage = useMemo(() => {
    if (activeDialog?.type !== "reader") {
      return null;
    }

    return messages.find((message) => message.id === activeDialog.messageId) ?? null;
  }, [activeDialog, messages]);

  useEffect(() => {
    props.controller.setExitHandler(() => exit());
    return () => {
      props.controller.setExitHandler(null);
    };
  }, [exit, props.controller]);

  const setCtrlCCapture = useCallback((capture: boolean) => {
    clearOnCtrlCRef.current = capture;
  }, []);

  const resetExitConfirmation = useCallback(() => {
    setExitConfirmationPending(false);
  }, []);

  const showCopyStatus = useCallback((status: string) => {
    if (copyStatusTimerRef.current) {
      clearTimeout(copyStatusTimerRef.current);
      copyStatusTimerRef.current = null;
    }

    setCopyStatusText(status);
    copyStatusTimerRef.current = setTimeout(() => {
      copyStatusTimerRef.current = null;
      setCopyStatusText(null);
    }, COPY_STATUS_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (copyStatusTimerRef.current) {
        clearTimeout(copyStatusTimerRef.current);
        copyStatusTimerRef.current = null;
      }
    };
  }, []);

  const copyTextToClipboard = useCallback(async (text: string, successStatus: string) => {
    if (!text) {
      return false;
    }

    try {
      const sequence = await setClipboard(text);
      if (sequence) {
        stdout.write(sequence);
      }

      showCopyStatus(successStatus);
      return true;
    } catch {
      showCopyStatus("Copy failed.");
      return false;
    }
  }, [showCopyStatus, stdout]);

  const syncTranscriptSticky = useCallback((sticky: boolean) => {
    store.updateState((state) => setTranscriptSticky(state, sticky));
  }, [store]);

  const keybindingHandlers = useMemo(() => ({
    "app:quit": () => {
      props.controller.requestExit();
    },
    "app:openSettings": () => {
      props.controller.openSettings(connection.apiKey ? "session" : "connection");
    },
    "app:escape": () => {
      if (isLoading) {
        props.controller.interrupt();
        return;
      }

      if (draftInput.trim().length === 0) {
        props.controller.openRewindSelector();
      }
    },
    "conversation:openDetail": () => {
      const detailTargetMessageId =
        transcriptRef.current?.getDetailTargetMessageId() ??
        selectedMessageId ??
        messages.at(-1)?.id ??
        null;

      if (detailTargetMessageId) {
        props.controller.openMessageReader(detailTargetMessageId);
      }
    },
    "conversation:previousMessage": () => {
      store.updateState((state) =>
        setTranscriptSticky(selectRelativeMessage(state, -1), false)
      );
    },
    "conversation:nextMessage": () => {
      store.updateState((state) =>
        setTranscriptSticky(selectRelativeMessage(state, 1), false)
      );
    },
    "scroll:lineUp": () => {
      transcriptRef.current?.scrollBy(-LINE_SCROLL_ROWS);
    },
    "scroll:lineDown": () => {
      transcriptRef.current?.scrollBy(LINE_SCROLL_ROWS);
    },
    "scroll:pageUp": () => {
      transcriptRef.current?.scrollPage(-1);
    },
    "scroll:pageDown": () => {
      transcriptRef.current?.scrollPage(1);
    },
    "scroll:top": () => {
      transcriptRef.current?.scrollToTop();
    },
    "scroll:bottom": () => {
      transcriptRef.current?.scrollToBottom();
    }
  }), [
    connection.apiKey,
    draftInput,
    isLoading,
    messages,
    props.controller,
    selectedMessageId,
    store
  ]);

  useKeybindings(keybindingHandlers, {
    contexts: ["Scroll", "Conversation", "Global"],
    isActive: !hasDialog && !hasActiveOverlay && !isReaderOpen
  });

  useTerminalInput((input, key) => {
    const normalizedInput = input.toLowerCase();
    const isCtrlC = key.ctrl && normalizedInput === "c";

    if (!isCtrlC && exitConfirmationPending) {
      resetExitConfirmation();
    }

    if (key.escape && activeDialog?.type === "permission") {
      props.controller.respondToApproval("reject-once");
      return;
    }

    if (isCtrlC) {
      const copiedSelectionText = selection.copySelection();
      if (copiedSelectionText) {
        resetExitConfirmation();
        showCopyStatus(`Copied ${copiedSelectionText.length} chars from selection.`);
        return;
      }

      if (!transcriptSticky) {
        const targetMessageId =
          transcriptRef.current?.getDetailTargetMessageId() ??
          selectedMessageId ??
          messages.at(-1)?.id ??
          null;
        const targetMessage =
          targetMessageId
            ? messages.find((message) => message.id === targetMessageId)
            : undefined;

        if (targetMessage?.content) {
          resetExitConfirmation();
          void copyTextToClipboard(targetMessage.content, "Copied selected message.");
          return;
        }
      }
    }

    if (isCtrlC && !clearOnCtrlCRef.current) {
      if (exitConfirmationPending) {
        resetExitConfirmation();
        props.controller.requestExit();
        return;
      }

      setExitConfirmationPending(true);
    }
  }, { isActive: !isReaderOpen });

  useEffect(() => {
    if (!exitConfirmationPending) {
      return;
    }

    if (clearOnCtrlCRef.current || hasDialog || hasActiveOverlay || isReaderOpen) {
      resetExitConfirmation();
    }
  }, [
    exitConfirmationPending,
    hasActiveOverlay,
    hasDialog,
    isReaderOpen,
    resetExitConfirmation
  ]);

  useEffect(() => {
    if (exitConfirmationPending && draftInput.length > 0) {
      resetExitConfirmation();
    }
  }, [draftInput.length, exitConfirmationPending, resetExitConfirmation]);

  useEffect(() => {
    if (!transcriptSticky || hasDialog || isReaderOpen) {
      return;
    }

    transcriptRef.current?.scrollToBottom();
  }, [hasDialog, isReaderOpen, messages.length, terminalHeight, terminalWidth, transcriptSticky]);

  const displayedStatusText = exitConfirmationPending
    ? EXIT_CONFIRMATION_STATUS
    : copyStatusText ?? statusText;
  const completedTodoCount = todos.filter((todo) => todo.status === "completed").length;
  const todoSummary = todos.length > 0 ? `${completedTodoCount}/${todos.length}` : undefined;

  const overlay =
    activeDialog?.type === "permission" ? (
      <ApprovalDialog
        request={activeDialog.request}
        onDecision={(decision) => props.controller.respondToApproval(decision)}
      />
    ) : activeDialog?.type === "question" ? (
      <AskUserQuestionDialog
        request={activeDialog.request}
        onSubmit={(response) => props.controller.respondToQuestion(response)}
        onCancel={() => props.controller.respondToQuestion(null)}
      />
    ) : activeDialog?.type === "settings" ? (
      <SettingsDialog
        visible
        initialSection={activeDialog.section}
        reason={activeDialog.reason}
        connection={connection}
        connectionState={connectionState}
        settings={settings}
        settingsState={settingsState}
        onClose={() => props.controller.closeDialog()}
        onSave={async (connectionPatch, settingsPatch, connectionTarget) => {
          await props.controller.saveConfig(connectionPatch, settingsPatch, connectionTarget);
        }}
        onCtrlCCaptureChange={setCtrlCCapture}
      />
    ) : activeDialog?.type === "session-picker" ? (
      <SessionPickerDialog
        sessions={activeDialog.sessions}
        onSelect={(sessionId) => {
          void props.controller.resumeSession(sessionId);
        }}
        onCancel={() => props.controller.closeDialog()}
      />
    ) : activeDialog?.type === "rewind-picker" ? (
      <RewindPickerDialog
        points={activeDialog.points}
        onRestore={(pointId, mode) => {
          void props.controller.restoreRewindPoint(pointId, mode);
        }}
        onCancel={() => props.controller.closeDialog()}
      />
    ) : null;

  const modal = readerMessage ? (
    <MessageReaderScreen
      message={readerMessage}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      markdownEnabled={settings.markdownMessageRenderingEnabled}
      onClose={() => props.controller.closeMessageReader()}
    />
  ) : null;

  const unseenMessagePill =
    !transcriptSticky && unseenMessageCount > 0 ? (
      <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
        {unseenMessageCount} new message{unseenMessageCount === 1 ? "" : "s"} | {LAST_MESSAGE_SHORTCUT} jump to bottom | {PAGE_UP_SHORTCUT}/{PAGE_DOWN_SHORTCUT} scroll | {OPEN_DETAIL_SHORTCUT} reader
      </Text>
    ) : null;

  const todoPanel = todos.length > 0 ? <TodoPanel todos={todos} /> : null;

  const pill =
    todoPanel || unseenMessagePill ? (
      <Box flexDirection="column" width="100%">
        {todoPanel}
        {todoPanel && unseenMessagePill ? <Text color={terminalUiTheme.colors.subtle}> </Text> : null}
        {unseenMessagePill}
      </Box>
    ) : null;

  return (
    <FullscreenLayout
      header={
        <StatusBar
          connection={connection}
          settings={settings}
          sessionApprovalMode={sessionApprovalMode}
          sessionAllowedKinds={sessionAllowedKinds}
          requestPatchCount={requestPatchCount}
          todoSummary={todoSummary}
          statusText={displayedStatusText}
        />
      }
      transcript={
        <ConversationPane
          ref={transcriptRef}
          terminalWidth={terminalWidth}
          unseenDividerMessageId={unseenDividerMessageId}
          unseenMessageCount={unseenMessageCount}
          onStickyChange={syncTranscriptSticky}
        />
      }
      pill={pill}
      overlay={overlay}
      modal={modal}
      bottom={
        <PromptInput
          value={draftInput}
          viewportWidth={terminalWidth}
          disabled={isLoading || hasDialog}
          disabledReason={
            hasDialog
              ? `${
                  getActiveDialog(store.getState())?.type === "permission"
                    ? "Resolve the permission request above"
                    : getActiveDialog(store.getState())?.type === "question"
                      ? "Resolve the question dialog above"
                      : "Resolve the active panel above"
                } before typing.`
              : isLoading
                ? "Input locked while Alyce is working. Press ESC to interrupt."
                : undefined
          }
          sublineText={`${connection.model} | ${workspaceRoot}`}
          onChange={(value) => props.controller.setDraftInput(value)}
          onCtrlCCaptureChange={setCtrlCCapture}
          onSubmit={async (value) => {
            resetExitConfirmation();
            await props.controller.submit(value);
          }}
        />
      }
    />
  );
}
