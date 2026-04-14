import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useStdout } from "../runtime/ink.js";
import { Layout } from "../components/Layout.js";
import { MessageList } from "../components/MessageList.js";
import { MessageReaderScreen } from "../components/MessageReaderScreen.js";
import { PromptInput } from "../components/PromptInput.js";
import { StatusBar } from "../components/StatusBar.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { SettingsDialog } from "../components/SettingsDialog.js";
import type { SessionController } from "../adapters/sessionController.js";
import { useIsOverlayActive } from "../context/overlayContext.js";
import { useKeybindings } from "../keybindings/useKeybindings.js";
import { useTerminalInput } from "../runtime/input.js";
import { setSelectedMessageId } from "../state/actions.js";
import { useTerminalUiSelector, useTerminalUiStore } from "../state/store.js";

const BODY_CHROME_ROWS = 15;
const MESSAGE_SCROLL_PAGE = 5;
const MIN_MESSAGE_VIEWPORT_ROWS = 8;
const EXIT_CONFIRMATION_STATUS = "Press Ctrl+C again to quit";

const ConversationPane = React.memo(function ConversationPane(props: {
  terminalWidth: number;
  viewportHeight: number;
  autoFollow: boolean;
}) {
  const messages = useTerminalUiSelector((value) => value.messages);
  const selectedMessageId = useTerminalUiSelector((value) => value.selectedMessageId);

  return (
    <MessageList
      messages={messages}
      selectedMessageId={selectedMessageId}
      viewportWidth={props.terminalWidth}
      viewportHeight={props.viewportHeight}
      autoFollow={props.autoFollow}
    />
  );
});

export function AgentScreen(props: { controller: SessionController }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const store = useTerminalUiStore();
  const dialog = useTerminalUiSelector((value) => value.dialog);
  const readerMessageId = useTerminalUiSelector((value) => value.readerMessageId);
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
  const selectedMessageId = useTerminalUiSelector((value) => value.selectedMessageId);
  const messagesLength = useTerminalUiSelector((value) => value.messages.length);
  const autoFollowMessages = useTerminalUiSelector((value) => value.autoFollowMessages);
  const selectedMessageIndex = useTerminalUiSelector((value) => {
    if (value.messages.length === 0) {
      return -1;
    }

    const currentIndex = value.messages.findIndex((message) => message.id === value.selectedMessageId);
    return currentIndex >= 0 ? currentIndex : value.messages.length - 1;
  });
  const readerMessage = useTerminalUiSelector((value) => {
    if (!readerMessageId) {
      return null;
    }

    return value.messages.find((message) => message.id === readerMessageId) ?? null;
  });
  const clearOnCtrlCRef = useRef(false);
  const [exitConfirmationPending, setExitConfirmationPending] = useState(false);
  const terminalWidth = stdout.columns || 120;
  const terminalHeight = stdout.rows || 36;
  const messageViewportHeight = Math.max(MIN_MESSAGE_VIEWPORT_ROWS, terminalHeight - BODY_CHROME_ROWS);
  const hasDialog = dialog !== null;
  const isReaderOpen = Boolean(readerMessage);
  const hasActiveOverlay = useIsOverlayActive();

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

  const focusMessageByIndex = useCallback((nextIndex: number) => {
    const currentState = store.getState();
    const nextMessage = currentState.messages[nextIndex];
    if (!nextMessage) {
      return;
    }

    store.updateState((state) => setSelectedMessageId(state, nextMessage.id));
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
        void props.controller.restoreLastInterruptedTurn();
      }
    },
    "conversation:openDetail": () => {
      if (selectedMessageId) {
        props.controller.openMessageReader(selectedMessageId);
      }
    },
    "conversation:previousMessage": () => {
      if (draftInput.length === 0) {
        focusMessageByIndex(Math.max(0, selectedMessageIndex - 1));
      }
    },
    "conversation:nextMessage": () => {
      if (draftInput.length === 0) {
        focusMessageByIndex(Math.min(messagesLength - 1, selectedMessageIndex + 1));
      }
    },
    "conversation:pageUp": () => {
      if (draftInput.length === 0) {
        focusMessageByIndex(Math.max(0, selectedMessageIndex - MESSAGE_SCROLL_PAGE));
      }
    },
    "conversation:pageDown": () => {
      if (draftInput.length === 0) {
        focusMessageByIndex(Math.min(messagesLength - 1, selectedMessageIndex + MESSAGE_SCROLL_PAGE));
      }
    },
    "conversation:firstMessage": () => {
      if (draftInput.length === 0) {
        focusMessageByIndex(0);
      }
    },
    "conversation:lastMessage": () => {
      if (draftInput.length === 0) {
        focusMessageByIndex(Math.max(0, messagesLength - 1));
      }
    }
  }), [
    connection.apiKey,
    draftInput,
    focusMessageByIndex,
    isLoading,
    messagesLength,
    props.controller,
    selectedMessageId,
    selectedMessageIndex
  ]);

  useKeybindings(keybindingHandlers, {
    contexts: ["Conversation", "Global"],
    isActive: !hasDialog && !hasActiveOverlay && !isReaderOpen
  });

  useTerminalInput((input, key) => {
    const normalizedInput = input.toLowerCase();
    const isCtrlC = key.ctrl && normalizedInput === "c";

    if (!isCtrlC && exitConfirmationPending) {
      resetExitConfirmation();
    }

    if (key.escape && dialog?.type === "permission") {
      props.controller.respondToApproval("reject-once");
      return;
    }

    // Only hijack Ctrl+C when there is no editable input to clear.
    if (isCtrlC && !clearOnCtrlCRef.current) {
      if (exitConfirmationPending) {
        resetExitConfirmation();
        props.controller.requestExit();
        return;
      }

      setExitConfirmationPending(true);
      return;
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

  const displayedStatusText = exitConfirmationPending ? EXIT_CONFIRMATION_STATUS : statusText;

  const overlay =
    dialog?.type === "permission" ? (
      <ApprovalDialog
        request={dialog.request}
        onDecision={(decision) => props.controller.respondToApproval(decision)}
      />
    ) : dialog?.type === "settings" ? (
      <SettingsDialog
        visible
        initialSection={dialog.section}
        reason={dialog.reason}
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
    ) : null;

  if (readerMessage) {
    return (
      <MessageReaderScreen
        message={readerMessage}
        terminalWidth={terminalWidth}
        terminalHeight={terminalHeight}
        onClose={() => props.controller.closeMessageReader()}
      />
    );
  }

  return (
    <Layout
      header={
        <StatusBar
          connection={connection}
          settings={settings}
          workspaceRoot={workspaceRoot}
          sessionApprovalMode={sessionApprovalMode}
          sessionAllowedKinds={sessionAllowedKinds}
          requestPatchCount={requestPatchCount}
          statusText={displayedStatusText}
        />
      }
      body={
        hasDialog
          ? null
          : (
              <ConversationPane
                terminalWidth={terminalWidth}
                viewportHeight={messageViewportHeight}
                autoFollow={autoFollowMessages}
              />
            )
      }
      footer={
        hasDialog
          ? null
          : (
              <PromptInput
                value={draftInput}
                viewportWidth={terminalWidth}
                disabled={isLoading}
                disabledReason={isLoading ? "Input locked while Alyce is working. Press ESC to interrupt." : undefined}
                sublineText={`${connection.model} · ${workspaceRoot}`}
                onChange={(value) => props.controller.setDraftInput(value)}
                onCtrlCCaptureChange={setCtrlCCapture}
                onSubmit={async (value) => {
                  resetExitConfirmation();
                  await props.controller.submit(value);
                }}
              />
            )
      }
      overlay={overlay}
    />
  );
}
