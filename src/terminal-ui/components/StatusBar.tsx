import type { ApprovalMode, ConnectionConfigState } from "../../config/runtime.js";
import { isConnectionStateReady } from "../../cli/modelCommand.js";
import type { ContextBudgetSnapshot } from "../../core/context/contextBudget.js";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

function formatApprovalMode(
  mode: ApprovalMode,
  allowedKinds: string[],
  fullApprovalEnabled: boolean
) {
  if (fullApprovalEnabled) {
    return "full";
  }

  if (mode === "auto") {
    return "auto";
  }

  if (allowedKinds.length === 0) {
    return "manual";
  }

  return `manual + ${allowedKinds.join(", ")}`;
}

export function StatusBar(props: {
  connectionState: ConnectionConfigState;
  sessionApprovalMode: ApprovalMode;
  sessionFullApprovalEnabled: boolean;
  sessionAllowedKinds: string[];
  requestPatchCount: number;
  planModeEnabled: boolean;
  todoSummary?: string;
  taskSummary?: string;
  statusText: string;
  contextBudget: ContextBudgetSnapshot | null;
}) {
  const isReady = isConnectionStateReady(props.connectionState);
  const connectionColor = isReady
    ? terminalUiTheme.colors.success
    : terminalUiTheme.colors.warning;
  const requestPatchText =
    props.requestPatchCount > 0
      ? ` | Request patches ${props.requestPatchCount}`
      : "";
  const todoSummaryText =
    props.todoSummary && props.todoSummary.trim().length > 0
      ? ` | Todos ${props.todoSummary}`
      : "";
  const taskSummaryText =
    props.taskSummary && props.taskSummary.trim().length > 0
      ? ` | Bg ${props.taskSummary}`
      : "";
  const contextText = ` | Context ${
    props.contextBudget ? `${Math.round(props.contextBudget.usedPercent)}%` : "--"
  }`;
  const contextColor =
    props.contextBudget?.state === "blocking"
      ? terminalUiTheme.colors.danger
      : props.contextBudget?.state === "warning" || props.contextBudget?.state === "auto_compact"
        ? terminalUiTheme.colors.warning
        : terminalUiTheme.colors.subtle;
  const normalizedStatusText = props.statusText.trim();
  const inlineStatusText =
    normalizedStatusText.length > 0 && !isContextStatusText(normalizedStatusText, Boolean(props.contextBudget))
      ? ` | ${normalizedStatusText}`
      : "";

  return (
    <Box width="100%">
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Alyce
        {requestPatchText}
        {" | "}
        <Text color={connectionColor}>{isReady ? "Ready" : "Setup required"}</Text>
        {" | "}
        Approval {formatApprovalMode(
          props.sessionApprovalMode,
          props.sessionAllowedKinds,
          props.sessionFullApprovalEnabled
        )}
        {" | "}
        Mode {props.planModeEnabled ? "Plan" : "Build"}
        {todoSummaryText}
        {taskSummaryText}
        <Text color={contextColor}>{contextText}</Text>
        <Text color={terminalUiTheme.colors.subtle}>{inlineStatusText}</Text>
      </Text>
    </Box>
  );
}

function isContextStatusText(value: string, hasContextBudget: boolean) {
  return hasContextBudget && /^Context\b/i.test(value);
}
