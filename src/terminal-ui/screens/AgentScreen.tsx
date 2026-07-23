import process from "node:process";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useApp from "../runtime/ink-runtime/hooks/use-app.js";
import useStdout from "../runtime/ink-runtime/hooks/use-stdout.js";
import useTerminalSize from "../runtime/ink-runtime/hooks/use-terminal-size.js";
import { FullscreenLayout } from "../components/FullscreenLayout.js";
import { MessageList, type MessageListHandle } from "../components/MessageList.js";
import { getInputLockedPlaceholder, PromptInput } from "../components/PromptInput.js";
import { StatusBar } from "../components/StatusBar.js";
import { TodoPanel } from "../components/TodoPanel.js";
import { TaskPanel } from "../components/TaskPanel.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { AskUserQuestionDialog } from "../components/AskUserQuestionDialog.js";
import { McpElicitationDialog } from "../components/McpElicitationDialog.js";
import { ConnectProviderDialog } from "../components/ConnectProviderDialog.js";
import { ModelPickerDialog } from "../components/ModelPickerDialog.js";
import { SettingsDialog } from "../components/SettingsDialog.js";
import { PermissionsDialog } from "../components/PermissionsDialog.js";
import { SessionPickerDialog } from "../components/SessionPickerDialog.js";
import { RewindPickerDialog } from "../components/RewindPickerDialog.js";
import type { SessionController } from "../adapters/sessionController.js";
import { formatCurrentModelDisplay } from "../../cli/modelCommand.js";
import { getBuiltinPersonaPresetTitle } from "../../core/prompt/fragments/personaPresets.js";
import { useIsOverlayActive } from "../context/overlayContext.js";
import { useKeybindings } from "../keybindings/useKeybindings.js";
import { getBindingDisplayText } from "../keybindings/shortcutDisplay.js";
import { useSelection } from "../runtime/ink-runtime/hooks/use-selection.js";
import { useTerminalInput } from "../runtime/input.js";
import { forceInkRedraw, invalidateInkPrevFrame } from "../runtime/instances.js";
import { logLayoutTrace } from "../runtime/utils/layoutTrace.js";
import { selectRelativeMessage, setTranscriptSticky } from "../state/actions.js";
import { useTerminalUiSelector, useTerminalUiStore } from "../state/store.js";
import { terminalUiTheme } from "../theme/theme.js";
import { useDoublePress } from "../hooks/useDoublePress.js";

const COPY_STATUS_DURATION_MS = 1800;
const PAGE_UP_SHORTCUT = getBindingDisplayText("scroll:pageUp", "Scroll") ?? "PgUp";
const PAGE_DOWN_SHORTCUT = getBindingDisplayText("scroll:pageDown", "Scroll") ?? "PgDn";
const LAST_MESSAGE_SHORTCUT = getBindingDisplayText("scroll:bottom", "Scroll") ?? "End";
const DEFAULT_LINE_SCROLL_ROWS = 2;
const SCROLL_ACCEL_WINDOW_MS = 220;
const SCROLL_ACCEL_MAX_MULTIPLIER = 4;

function resolveAssistantLabel(personaPreset?: string) {
  return getBuiltinPersonaPresetTitle(personaPreset)?.toUpperCase() ?? "ALYCE";
}

const ConversationPane = React.memo(React.forwardRef<MessageListHandle, {
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  maxMessagesWithoutVirtualization: number;
  isLoading: boolean;
  onStickyChange: (sticky: boolean) => void;
  onNearTop: (visibleMessageId: string | null) => void;
}>(function ConversationPane(props, ref) {
  const terminalSize = useTerminalSize();
  const messages = useTerminalUiSelector((value) => value.messages);
  const selectedMessageId = useTerminalUiSelector((value) => value.selectedMessageId);
  const markdownEnabled = useTerminalUiSelector(
    (value) => value.settings.markdownMessageRenderingEnabled
  );
  const markdownToolMessageRenderingEnabled = useTerminalUiSelector(
    (value) => value.settings.markdownToolMessageRenderingEnabled
  );
  const markdownRenderMaxChars = useTerminalUiSelector(
    (value) => value.settings.markdownRenderMaxChars
  );
  const thinkingMessagesExpandedByDefault = useTerminalUiSelector(
    (value) => value.settings.thinkingMessagesExpandedByDefault
  );
  const showMessageTimestamps = useTerminalUiSelector(
    (value) => value.settings.showMessageTimestamps
  );
  const assistantLabel = useTerminalUiSelector(
    (value) => resolveAssistantLabel(value.settings.personaPreset)
  );

  return (
    <MessageList
      ref={ref}
      messages={messages}
      selectedMessageId={selectedMessageId}
      viewportWidth={terminalSize.columns}
      markdownEnabled={markdownEnabled}
      markdownToolMessageRenderingEnabled={markdownToolMessageRenderingEnabled}
      markdownRenderMaxChars={markdownRenderMaxChars}
      thinkingMessagesExpandedByDefault={thinkingMessagesExpandedByDefault}
      showMessageTimestamps={showMessageTimestamps}
      maxMessagesWithoutVirtualization={props.maxMessagesWithoutVirtualization}
      isLoading={props.isLoading}
      assistantLabel={assistantLabel}
      unseenDividerMessageId={props.unseenDividerMessageId}
      unseenMessageCount={props.unseenMessageCount}
      onStickyChange={props.onStickyChange}
      onNearTop={props.onNearTop}
    />
  );
}));

export function AgentScreen(props: { controller: SessionController }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalSize = useTerminalSize();
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
  const planModeEnabled = useTerminalUiSelector((value) => value.planModeEnabled);
  const contextBudget = useTerminalUiSelector((value) => value.contextBudget);
  const isLoading = useTerminalUiSelector((value) => value.isLoading);
  // draftInput 不在此订阅：每键改 draft 不应重渲染 StatusBar/布局，输入由 AgentPromptDock 隔离。
  const todos = useTerminalUiSelector((value) => value.todos);
  const backgroundTasks = useTerminalUiSelector((value) => value.backgroundTasks);
  const backgroundProcessCount = useTerminalUiSelector((value) => value.backgroundProcessCount);
  const transcriptSticky = useTerminalUiSelector((value) => value.transcriptSticky);
  const unseenDividerMessageId = useTerminalUiSelector((value) => value.unseenDividerMessageId);
  const unseenMessageCount = useTerminalUiSelector((value) => value.unseenMessageCount);
  const maxMessagesWithoutVirtualization = useTerminalUiSelector(
    (value) => value.settings.maxMessagesWithoutVirtualization
  );
  const scrollSpeed = useTerminalUiSelector((value) => value.settings.scrollSpeed);
  const scrollAccelerationEnabled = useTerminalUiSelector(
    (value) => value.settings.scrollAccelerationEnabled
  );
  const messageCount = useTerminalUiSelector((value) => value.messages.length);
  const clearOnCtrlCRef = useRef(false);
  const captureVerticalNavRef = useRef(false);
  const transcriptRef = useRef<MessageListHandle | null>(null);
  const scrollAccelerationRef = useRef<{
    lastDirection: -1 | 0 | 1;
    lastAtMs: number;
    streak: number;
  }>({
    lastDirection: 0,
    lastAtMs: 0,
    streak: 0
  });
  const copyStatusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [copyStatusText, setCopyStatusText] = useState<string | null>(null);
  const [historyEscPending, setHistoryEscPending] = useState(false);
  const terminalWidth = terminalSize.columns;
  const terminalHeight = terminalSize.rows;
  const activeDialog = dialogQueue[0] ?? null;
  const hasDialog = activeDialog !== null;
  const hasActiveOverlay = useIsOverlayActive();
  const layoutSurfaceKey =
    activeDialog === null
      ? "conversation"
      : `${activeDialog.layer}:${activeDialog.type}`;
  const layoutSurfaceKeyRef = useRef(layoutSurfaceKey);
  const terminalSizeKey = `${terminalWidth}x${terminalHeight}`;
  const terminalSizeKeyRef = useRef(terminalSizeKey);

  useEffect(() => {
    props.controller.setExitHandler(() => exit());
    return () => {
      props.controller.setExitHandler(null);
    };
  }, [exit, props.controller]);

  useLayoutEffect(() => {
    if (layoutSurfaceKeyRef.current !== layoutSurfaceKey) {
      logLayoutTrace("agent-screen:surface", {
        previous: layoutSurfaceKeyRef.current,
        next: layoutSurfaceKey,
        terminal: `${terminalWidth}x${terminalHeight}`,
        hasDialog,
        activeDialog: activeDialog?.type ?? null
      });
      layoutSurfaceKeyRef.current = layoutSurfaceKey;
      invalidateInkPrevFrame(stdout as NodeJS.WriteStream);
      queueMicrotask(() => {
        transcriptRef.current?.refreshViewport();
      });
    }
  }, [activeDialog?.type, hasDialog, layoutSurfaceKey, stdout, terminalHeight, terminalWidth]);

  useLayoutEffect(() => {
    if (terminalSizeKeyRef.current === terminalSizeKey) {
      return;
    }

    logLayoutTrace("agent-screen:terminal-change", {
      previous: terminalSizeKeyRef.current,
      next: terminalSizeKey,
      surface: layoutSurfaceKey
    });
    terminalSizeKeyRef.current = terminalSizeKey;
    queueMicrotask(() => {
      forceInkRedraw(stdout as NodeJS.WriteStream);
      transcriptRef.current?.refreshViewport();
    });
  }, [layoutSurfaceKey, stdout, terminalSizeKey]);

  useEffect(() => {
    logLayoutTrace("agent-screen:size", {
      terminal: `${terminalWidth}x${terminalHeight}`,
      surface: layoutSurfaceKey,
      hasDialog,
      hasActiveOverlay
    });
  }, [hasActiveOverlay, hasDialog, layoutSurfaceKey, terminalHeight, terminalWidth]);

  const setCtrlCCapture = useCallback((capture: boolean) => {
    clearOnCtrlCRef.current = capture;
  }, []);

  const setVerticalNavCapture = useCallback((capture: boolean) => {
    captureVerticalNavRef.current = capture;
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

  const syncTranscriptSticky = useCallback((sticky: boolean) => {
    store.updateState((state) => setTranscriptSticky(state, sticky));
  }, [store]);

  const refreshPromptLayout = useCallback(() => {
    invalidateInkPrevFrame(stdout as NodeJS.WriteStream);
    queueMicrotask(() => {
      transcriptRef.current?.refreshViewport();
    });
  }, [stdout]);

  const handleTranscriptNearTop = useCallback((visibleMessageId: string | null) => {
    props.controller.loadOlderSessionMessages(visibleMessageId);
  }, [props.controller]);

  const resetScrollAcceleration = useCallback(() => {
    scrollAccelerationRef.current = {
      lastDirection: 0,
      lastAtMs: 0,
      streak: 0
    };
  }, []);

  const resolveLineScrollRows = useCallback((direction: -1 | 1) => {
    const baseRows = Math.max(1, Math.trunc(scrollSpeed || DEFAULT_LINE_SCROLL_ROWS));
    if (!scrollAccelerationEnabled) {
      resetScrollAcceleration();
      return baseRows;
    }

    const nowMs = Date.now();
    const previous = scrollAccelerationRef.current;
    const shouldAccelerate =
      previous.lastDirection === direction &&
      nowMs - previous.lastAtMs <= SCROLL_ACCEL_WINDOW_MS;
    const nextStreak = shouldAccelerate
      ? Math.min(previous.streak + 1, SCROLL_ACCEL_MAX_MULTIPLIER * 2)
      : 1;
    const multiplier = Math.min(
      SCROLL_ACCEL_MAX_MULTIPLIER,
      1 + Math.floor((nextStreak - 1) / 2)
    );

    scrollAccelerationRef.current = {
      lastDirection: direction,
      lastAtMs: nowMs,
      streak: nextStreak
    };

    return baseRows * multiplier;
  }, [resetScrollAcceleration, scrollAccelerationEnabled, scrollSpeed]);

  const { trigger: triggerHistoryEscape, reset: resetHistoryEscape } = useDoublePress(
    setHistoryEscPending,
    () => {
      // 读 store 快照，避免订阅 draftInput 导致整屏随按键重渲染。
      if (!isLoading && store.getState().draftInput.length === 0) {
        props.controller.openRewindSelector();
      }
    }
  );

  useEffect(() => {
    if (isLoading || hasDialog || hasActiveOverlay) {
      resetHistoryEscape();
    }
  }, [hasActiveOverlay, hasDialog, isLoading, resetHistoryEscape]);

  // draft 从空到非空时取消 Esc 二次确认，不触发 AgentScreen 重渲染。
  useEffect(() => {
    return store.subscribe(() => {
      if (store.getState().draftInput.length > 0) {
        resetHistoryEscape();
      }
    });
  }, [resetHistoryEscape, store]);

  const keybindingHandlers = useMemo(() => ({
    "app:quit": () => {
      if (isLoading) {
        props.controller.interrupt();
        return;
      }

      props.controller.requestExit();
    },
    "app:openSettings": () => {
      props.controller.openSettings("session");
    },
    "app:escape": () => {
      if (isLoading) {
        resetHistoryEscape();
        props.controller.interrupt();
        return;
      }

      if (store.getState().draftInput.length > 0) {
        resetHistoryEscape();
        return;
      }

      triggerHistoryEscape();
    },
    "conversation:previousMessage": () => {
      // 多行输入编辑中 up/down 留给光标，不切换会话消息（否则大段粘贴后上移会抖/移不动）。
      if (captureVerticalNavRef.current) {
        return;
      }
      store.updateState((state) =>
        setTranscriptSticky(selectRelativeMessage(state, -1), false)
      );
    },
    "conversation:nextMessage": () => {
      if (captureVerticalNavRef.current) {
        return;
      }
      store.updateState((state) =>
        setTranscriptSticky(selectRelativeMessage(state, 1), false)
      );
    },
    "scroll:lineUp": () => {
      transcriptRef.current?.scrollBy(-resolveLineScrollRows(-1));
    },
    "scroll:lineDown": () => {
      transcriptRef.current?.scrollBy(resolveLineScrollRows(1));
    },
    "scroll:pageUp": () => {
      resetScrollAcceleration();
      transcriptRef.current?.scrollPage(-1);
    },
    "scroll:pageDown": () => {
      resetScrollAcceleration();
      transcriptRef.current?.scrollPage(1);
    },
    "scroll:top": () => {
      resetScrollAcceleration();
      transcriptRef.current?.scrollToTop();
    },
    "scroll:bottom": () => {
      resetScrollAcceleration();
      transcriptRef.current?.scrollToBottom();
    }
  }), [
    isLoading,
    props.controller,
    resetScrollAcceleration,
    resolveLineScrollRows,
    resetHistoryEscape,
    triggerHistoryEscape,
    store
  ]);

  useKeybindings(keybindingHandlers, {
    contexts: ["Scroll", "Conversation", "Global"],
    isActive: !hasDialog && !hasActiveOverlay
  });

  useTerminalInput((input, key) => {
    const normalizedInput = input.toLowerCase();
    const isCtrlC = key.ctrl && normalizedInput === "c";

    if (key.escape && activeDialog?.type === "permission") {
      props.controller.respondToApproval("reject-once");
      return;
    }

    if (!isCtrlC) {
      return;
    }

    const copiedSelectionText = selection.copySelection();
    if (copiedSelectionText) {
      showCopyStatus(`Copied ${copiedSelectionText.length} chars from selection.`);
      return;
    }

    if (clearOnCtrlCRef.current || store.getState().draftInput.length > 0) {
      props.controller.setDraftInput("");
      return;
    }

    // 运行中按“退出类”快捷键时，优先做安全中断，避免当前轮次还没清理完就离开 UI。
    if (isLoading) {
      props.controller.interrupt();
      return;
    }

    props.controller.requestExit();
  }, { isActive: !hasDialog });

  useEffect(() => {
    if (!transcriptSticky || hasDialog) {
      return;
    }

    transcriptRef.current?.scrollToBottom();
  }, [hasDialog, messageCount, terminalHeight, terminalWidth, transcriptSticky]);

  const displayedStatusText =
    copyStatusText ?? (historyEscPending ? "Press ESC again to open revert history." : statusText);
  const completedTodoCount = todos.filter((todo) => todo.status === "completed").length;
  const todoSummary = todos.length > 0 ? `${completedTodoCount}/${todos.length}` : undefined;
  const taskSummary = backgroundTasks.length > 0 ? `${backgroundTasks.length} run` : "";
  const promptDisabledReason =
    hasDialog
      ? `${
          activeDialog?.type === "permission"
            ? "Resolve the permission request above"
            : activeDialog?.type === "question"
              ? "Resolve the question dialog above"
              : "Resolve the active panel above"
        } before typing.`
      : undefined;
  const promptDisabledPlaceholder =
    isLoading && !hasDialog
      ? getInputLockedPlaceholder()
      : undefined;

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
    ) : activeDialog?.type === "mcp-elicitation" ? (
      <McpElicitationDialog
        request={activeDialog.request}
        onSubmit={(response) => props.controller.respondToMcpElicitation(response)}
        onCancel={() => props.controller.respondToMcpElicitation({ action: "cancel" })}
        onDecline={() => props.controller.respondToMcpElicitation({ action: "decline" })}
      />
    ) : activeDialog?.type === "settings" ? (
      <SettingsDialog
        visible
        reason={activeDialog.reason}
        settings={settings}
        settingsState={settingsState}
        onClose={() => props.controller.closeDialog()}
        onSave={async (settingsPatch) => {
          await props.controller.saveConfig(settingsPatch);
        }}
        onCtrlCCaptureChange={setCtrlCCapture}
      />
    ) : activeDialog?.type === "permissions" ? (
      <PermissionsDialog
        mode={sessionApprovalMode}
        onSelect={(mode) => {
          void props.controller.setApprovalMode(mode);
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

  const modal =
    activeDialog?.type === "connect-provider" ? (
      <ConnectProviderDialog
        connectionState={connectionState}
        onConnect={(provider, args) => props.controller.connectProviderFromDialog(provider, args)}
        onAuthorizeAuth={(provider, methodIndex, inputs) =>
          props.controller.authorizeProviderAuthFromDialog(provider, methodIndex, inputs)}
        onAuthCallback={(provider, methodIndex, code, options) =>
          props.controller.completeProviderAuthFromDialog(provider, methodIndex, code, options)}
        onCancelAuth={(provider, methodIndex) =>
          props.controller.cancelProviderAuthFromDialog(provider, methodIndex)}
        onCancel={() => props.controller.closeDialog()}
      />
    ) : activeDialog?.type === "session-picker" ? (
      <SessionPickerDialog
        sessions={activeDialog.sessions}
        onSelect={(sessionId) => {
          void props.controller.resumeSession(sessionId);
        }}
        onCancel={() => props.controller.closeDialog()}
      />
    ) : activeDialog?.type === "model-picker" ? (
      <ModelPickerDialog
        connectionState={connectionState}
        settings={settings}
        currentModel={connection.model}
        refreshState={activeDialog.state}
        env={process.env}
        onSelect={(model) => props.controller.switchModelFromDialog(model)}
        onCancel={() => props.controller.closeDialog()}
      />
    ) : null;

  const unseenMessagePill =
    !transcriptSticky && unseenMessageCount > 0 ? (
      <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
        {unseenMessageCount} new message{unseenMessageCount === 1 ? "" : "s"} | {LAST_MESSAGE_SHORTCUT} jump to bottom | {PAGE_UP_SHORTCUT}/{PAGE_DOWN_SHORTCUT} scroll
      </Text>
    ) : null;
  const todoPanel = todos.length > 0 ? <TodoPanel todos={todos} /> : null;
  const taskPanel = backgroundTasks.length > 0 ? <TaskPanel tasks={backgroundTasks} /> : null;

  const pill =
    todoPanel || taskPanel || unseenMessagePill ? (
      <Box flexDirection="column" width="100%">
        {todoPanel}
        {todoPanel && taskPanel ? <Text color={terminalUiTheme.colors.subtle}> </Text> : null}
        {taskPanel}
        {(todoPanel || taskPanel) && unseenMessagePill ? <Text color={terminalUiTheme.colors.subtle}> </Text> : null}
        {unseenMessagePill}
      </Box>
    ) : null;

  return (
    <FullscreenLayout
      header={
        <StatusBar
          connectionState={connectionState}
          sessionApprovalMode={sessionApprovalMode}
          sessionAllowedKinds={sessionAllowedKinds}
          requestPatchCount={requestPatchCount}
          planModeEnabled={planModeEnabled}
          todoSummary={todoSummary}
          taskSummary={taskSummary}
          backgroundProcessCount={backgroundProcessCount}
          statusText={displayedStatusText}
          contextBudget={contextBudget}
        />
      }
      transcript={
        <ConversationPane
          ref={transcriptRef}
          unseenDividerMessageId={unseenDividerMessageId}
          unseenMessageCount={unseenMessageCount}
          maxMessagesWithoutVirtualization={maxMessagesWithoutVirtualization}
          isLoading={isLoading}
          onStickyChange={syncTranscriptSticky}
          onNearTop={handleTranscriptNearTop}
        />
      }
      pill={pill}
      overlay={overlay}
      modal={modal}
      bottom={
        <AgentPromptDock
          controller={props.controller}
          terminalWidth={terminalWidth}
          disabled={isLoading || hasDialog}
          disabledReason={promptDisabledReason}
          disabledPlaceholder={promptDisabledPlaceholder}
          sublineText={`${formatCompactModelDisplay(connection.model)} | ${workspaceRoot}`}
          onLayoutHeightChange={refreshPromptLayout}
          onCtrlCCaptureChange={setCtrlCCapture}
          onVerticalNavCaptureChange={setVerticalNavCapture}
        />
      }
    />
  );
}

type AgentPromptDockProps = {
  controller: SessionController;
  terminalWidth: number;
  disabled: boolean;
  disabledReason?: string;
  disabledPlaceholder?: string;
  sublineText: string;
  onLayoutHeightChange: () => void;
  onCtrlCCaptureChange: (capture: boolean) => void;
  onVerticalNavCaptureChange: (capture: boolean) => void;
};

// 输入区与主屏解耦：仅在“外部写入” draft 时同步 props.value（恢复/清空等）。
// 打字 UI 由 PromptInput.localValue 承担，避免 AgentScreen/StatusBar 随按键重渲染。
const AgentPromptDock = React.memo(function AgentPromptDock(props: AgentPromptDockProps) {
  const store = useTerminalUiStore();
  const [draftInput, setDraftInput] = useState(() => store.getState().draftInput);
  // 外部写入（Ctrl+C 清空 / 恢复会话等）时递增，强制 PromptInput 同步本地缓冲。
  const [externalRevision, setExternalRevision] = useState(0);
  // 标记“本次 store 变更来自输入框自身”，避免 subscribe 把本地正在编辑的值回弹。
  const selfWriteRef = useRef(false);
  // 只跟踪 draftInput：无关 store 更新（消息流、status、loading）不得 bump，
  // 否则 PromptInput 会把光标强制拉到末尾并引发输入抖动。
  const lastDraftRef = useRef(store.getState().draftInput);

  useEffect(() => {
    return store.subscribe(() => {
      const next = store.getState().draftInput;
      if (selfWriteRef.current) {
        selfWriteRef.current = false;
        lastDraftRef.current = next;
        return;
      }
      // draft 未变时忽略 streaming / status 等频繁 notify。
      if (next === lastDraftRef.current) {
        return;
      }
      lastDraftRef.current = next;
      setDraftInput(next);
      setExternalRevision((revision) => revision + 1);
    });
  }, [store]);

  return (
    <PromptInput
      // 不要用 terminalSize 当 key 强制 remount：本地输入缓冲会丢，且列宽已在 PromptInput 内响应。
      value={draftInput}
      externalRevision={externalRevision}
      viewportWidth={props.terminalWidth}
      disabled={props.disabled}
      disabledReason={props.disabledReason}
      disabledPlaceholder={props.disabledPlaceholder}
      sublineText={props.sublineText}
      onLayoutHeightChange={props.onLayoutHeightChange}
      onChange={(value) => {
        // 只写 store 供快捷键读快照；UI 不依赖 dock state。
        const before = store.getState().draftInput;
        selfWriteRef.current = true;
        props.controller.setDraftInput(value);
        // setDraftInput 值未变时不会 notify，必须手动清标记，否则会吞掉后续外部写入。
        if (store.getState().draftInput === before) {
          selfWriteRef.current = false;
        }
      }}
      onCtrlCCaptureChange={props.onCtrlCCaptureChange}
      onVerticalNavCaptureChange={props.onVerticalNavCaptureChange}
      onModeToggle={() => props.controller.togglePlanMode()}
      onSubmit={async (value) => {
        await props.controller.submit(value);
      }}
    />
  );
});

function formatCompactModelDisplay(model: string) {
  const display = formatCurrentModelDisplay(model);
  return display.startsWith("openai/") ? display.slice("openai/".length) : display;
}
