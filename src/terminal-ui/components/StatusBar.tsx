import React from "react";
import type { ApprovalMode, ConnectionConfig, SessionSettings } from "../../config/runtime.js";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

function maskApiKey(apiKey: string) {
  if (!apiKey) {
    return "missing";
  }

  if (apiKey.length <= 8) {
    return "configured";
  }

  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

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
  workspaceRoot: string;
  sessionApprovalMode: ApprovalMode;
  sessionAllowedKinds: string[];
  requestPatchCount: number;
  statusText: string;
}) {
  const isReady = props.connection.apiKey.trim().length > 0;

  return (
    <Box
      borderStyle="round"
      borderColor={terminalUiTheme.colors.border}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      <Text color={terminalUiTheme.colors.chrome}>{terminalUiTheme.chrome.title}</Text>
      <Text
        color={isReady ? terminalUiTheme.colors.success : terminalUiTheme.colors.warning}
        wrap="truncate-end"
      >
        {isReady ? "Connected" : "Setup required"}
        {" | "}
        Model {props.connection.model}
        {" | "}
        API {maskApiKey(props.connection.apiKey)}
      </Text>
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Workspace: {props.workspaceRoot}
      </Text>
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Approval: {formatApprovalMode(props.sessionApprovalMode, props.sessionAllowedKinds)}
        {" | "}
        Max steps: {props.settings.maxSteps}
        {" | "}
        Timeout: {props.settings.commandTimeoutMs} ms
        {props.requestPatchCount > 0 ? ` | Request patches: ${props.requestPatchCount}` : ""}
      </Text>
      <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
        Status: {props.statusText}
        {" | "}
        /settings | Ctrl+X settings | Ctrl+C clear input or quit | Ctrl+Q quit
      </Text>
    </Box>
  );
}
