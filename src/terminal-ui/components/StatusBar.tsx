import React from "react";
import type { ApprovalMode, ConnectionConfig, SessionSettings } from "../../config/runtime.js";
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
  settings: SessionSettings;
  sessionApprovalMode: ApprovalMode;
  sessionAllowedKinds: string[];
  requestPatchCount: number;
  todoSummary?: string;
  statusText: string;
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
  const inlineStatusText =
    props.statusText.trim().length > 0 ? ` | ${props.statusText}` : "";

  return (
    <Box width="100%">
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Alyce
        {" | "}
        Max steps: {props.settings.maxSteps}
        {" | "}
        Timeout: {props.settings.commandTimeoutMs} ms
        {requestPatchText}
        {" | "}
        <Text color={connectionColor}>{isReady ? "Ready" : "Setup required"}</Text>
        {" | "}
        Model {props.connection.model}
        {" | "}
        Approval {formatApprovalMode(props.sessionApprovalMode, props.sessionAllowedKinds)}
        {todoSummaryText}
        <Text color={terminalUiTheme.colors.subtle}>{inlineStatusText}</Text>
      </Text>
    </Box>
  );
}
