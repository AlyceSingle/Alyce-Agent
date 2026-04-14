import React from "react";
import type { ApprovalMode, ConnectionConfig, SessionSettings } from "../../config/runtime.js";
import { Box, Text } from "../runtime/ink.js";
import { getBindingDisplayText } from "../keybindings/shortcutDisplay.js";
import { terminalUiTheme } from "../theme/theme.js";

const OPEN_SETTINGS_SHORTCUT = getBindingDisplayText("app:openSettings", "Global") ?? "Ctrl+X";
const QUIT_SHORTCUT = getBindingDisplayText("app:quit", "Global") ?? "Ctrl+Q";
const OPEN_DETAIL_SHORTCUT = getBindingDisplayText("conversation:openDetail", "Global") ?? "Ctrl+O";
const ESCAPE_SHORTCUT = getBindingDisplayText("app:escape", "Global") ?? "Esc";

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
  const connectionColor = isReady
    ? terminalUiTheme.colors.success
    : terminalUiTheme.colors.warning;

  return (
    <Box
      borderStyle="round"
      borderColor={terminalUiTheme.colors.border}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
        {terminalUiTheme.chrome.title}
        {" | "}
        <Text color={connectionColor}>{isReady ? "Ready" : "Setup required"}</Text>
        {" | "}
        Model {props.connection.model}
      </Text>
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Workspace: {props.workspaceRoot}
      </Text>
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Approval: {formatApprovalMode(props.sessionApprovalMode, props.sessionAllowedKinds)}
        {" | "}
        API: {maskApiKey(props.connection.apiKey)}
        {" | "}
        Max steps: {props.settings.maxSteps}
        {" | "}
        Timeout: {props.settings.commandTimeoutMs} ms
        {props.requestPatchCount > 0 ? ` | Request patches: ${props.requestPatchCount}` : ""}
      </Text>
      <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
        Status: {props.statusText}
        {" | "}
        {OPEN_DETAIL_SHORTCUT} reader
        {" | "}
        {OPEN_SETTINGS_SHORTCUT} settings
        {" | "}
        {ESCAPE_SHORTCUT} interrupt/restore
        {" | "}
        {QUIT_SHORTCUT} quit
      </Text>
    </Box>
  );
}
