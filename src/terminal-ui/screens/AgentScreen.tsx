import React, { useCallback, useEffect, useRef } from "react";
import { useApp, useInput, useStdout } from "../runtime/ink.js";
import { Layout } from "../components/Layout.js";
import { MessageList } from "../components/MessageList.js";
import { PromptInput } from "../components/PromptInput.js";
import { StatusBar } from "../components/StatusBar.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { SettingsDialog } from "../components/SettingsDialog.js";
import { MessageDetailDialog } from "../components/MessageDetailDialog.js";
import type { SessionController } from "../adapters/sessionController.js";
import { useTerminalUiSelector } from "../state/store.js";

export function AgentScreen(props: { controller: SessionController }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const state = useTerminalUiSelector((value) => value);
  const clearOnCtrlCRef = useRef(false);
  const terminalWidth = stdout.columns || 120;
  const terminalHeight = stdout.rows || 36;
  const hasDialog = state.dialog !== null;
  const detailDialog = state.dialog?.type === "message-detail" ? state.dialog : null;
  const detailMessage = detailDialog
    ? state.messages.find((message) => message.id === detailDialog.messageId) ?? null
    : null;

  useEffect(() => {
    props.controller.setExitHandler(() => exit());
    return () => {
      props.controller.setExitHandler(null);
    };
  }, [exit, props.controller]);

  const setCtrlCCapture = useCallback((capture: boolean) => {
    clearOnCtrlCRef.current = capture;
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "q") {
      props.controller.requestExit();
      return;
    }

    // 由当前可编辑输入决定是否把 Ctrl+C 解释为清空；否则保持正常退出。
    if (key.ctrl && input.toLowerCase() === "c") {
      if (!clearOnCtrlCRef.current) {
        props.controller.requestExit();
      }
      return;
    }

    if (key.ctrl && input.toLowerCase() === "x") {
      props.controller.openSettings(state.connection.apiKey ? "session" : "connection");
    }
  }, { isActive: true });

  const overlay =
    state.dialog?.type === "permission" ? (
      <ApprovalDialog
        request={state.dialog.request}
        onDecision={(decision) => props.controller.respondToApproval(decision)}
      />
    ) : state.dialog?.type === "settings" ? (
      <SettingsDialog
        visible
        initialSection={state.dialog.section}
        reason={state.dialog.reason}
        connection={state.connection}
        settings={state.settings}
        onClose={() => props.controller.closeDialog()}
        onSave={async (connection, settings) => {
          await props.controller.saveConfig(connection, settings);
        }}
        onCtrlCCaptureChange={setCtrlCCapture}
      />
    ) : state.dialog?.type === "message-detail" ? (
      <MessageDetailDialog
        visible
        message={detailMessage}
        viewportWidth={terminalWidth}
        viewportHeight={terminalHeight}
        onClose={() => props.controller.closeDialog()}
      />
    ) : null;

  return (
    <Layout
      header={
        <StatusBar
          connection={state.connection}
          settings={state.settings}
          workspaceRoot={state.workspaceRoot}
          sessionApprovalMode={state.sessionApprovalMode}
          sessionAllowedKinds={state.sessionAllowedKinds}
          requestPatchCount={state.requestPatchCount}
          statusText={state.statusText}
        />
      }
      body={
        hasDialog
          ? null
          : (
              <MessageList
                messages={state.messages}
                selectedMessageId={state.selectedMessageId}
                viewportWidth={terminalWidth}
              />
            )
      }
      footer={
        hasDialog
          ? null
          : (
              <PromptInput
                viewportWidth={terminalWidth}
                disabled={state.isLoading}
                disabledReason={state.isLoading ? "Input locked while Alyce is working." : undefined}
                onCtrlCCaptureChange={setCtrlCCapture}
                onSubmit={async (value) => {
                  await props.controller.submit(value);
                }}
              />
            )
      }
      overlay={overlay}
    />
  );
}
