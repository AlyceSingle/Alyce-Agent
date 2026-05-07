import type { ApprovalMode, ConnectionConfig } from "../../config/runtime.js";
import type { ContextBudgetSnapshot } from "../../core/context/contextBudget.js";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

function formatApprovalMode(mode: ApprovalMode, allowedKinds: string[]) {
  if (mode === "auto") {
    return "auto";
  }

  if (allowedKinds.length === 0) {
    return "manual";
  }

  return `manual + ${allowedKinds.join(", ")}`;
}

export function StatusBar(props: {
  connection: ConnectionConfig;
  sessionApprovalMode: ApprovalMode;
  sessionAllowedKinds: string[];
  requestPatchCount: number;
  todoSummary?: string;
  statusText: string;
  contextBudget: ContextBudgetSnapshot | null;
}) {
  const isReady = props.connection.apiKey.trim().length > 0;
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
  const contextText = props.contextBudget
    ? ` | Context ${Math.round(props.contextBudget.usedPercent)}%`
    : "";
  const contextColor =
    props.contextBudget?.state === "blocking"
      ? terminalUiTheme.colors.danger
      : props.contextBudget?.state === "warning" || props.contextBudget?.state === "auto_compact"
        ? terminalUiTheme.colors.warning
        : terminalUiTheme.colors.subtle;
  const inlineStatusText =
    props.statusText.trim().length > 0 ? ` | ${props.statusText}` : "";

  return (
    <Box width="100%">
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Alyce
        {requestPatchText}
        {" | "}
        <Text color={connectionColor}>{isReady ? "Ready" : "Setup required"}</Text>
        {" | "}
        Model {props.connection.model}
        {" | "}
        Approval {formatApprovalMode(props.sessionApprovalMode, props.sessionAllowedKinds)}
        {todoSummaryText}
        <Text color={contextColor}>{contextText}</Text>
        <Text color={terminalUiTheme.colors.subtle}>{inlineStatusText}</Text>
      </Text>
    </Box>
  );
}
