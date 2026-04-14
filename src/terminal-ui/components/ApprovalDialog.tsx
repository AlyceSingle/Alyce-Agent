import React, { useEffect, useState } from "react";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { Box, Text, useInput } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import type { PermissionDecision } from "../state/types.js";
import { Pane } from "./Pane.js";

const APPROVAL_OPTIONS: Array<{
  id: PermissionDecision;
  label: string;
  description: string;
}> = [
  {
    id: "allow-once",
    label: "Allow once",
    description: "Approve only this request."
  },
  {
    id: "reject-once",
    label: "Reject once",
    description: "Deny only this request."
  },
  {
    id: "allow-kind-session",
    label: "Allow this kind for session",
    description: "Skip prompts for this permission kind until restart."
  },
  {
    id: "auto-approve-session",
    label: "Auto approve this session",
    description: "Disable further approval prompts for this run."
  }
];

export function ApprovalDialog(props: {
  request: ToolApprovalRequest | null;
  onDecision: (decision: PermissionDecision) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useRegisterOverlay("permission", Boolean(props.request));

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.request?.summary, props.request?.title]);

  useInput((input, key) => {
    if (!props.request) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(APPROVAL_OPTIONS.length - 1, current + 1));
      return;
    }

    if (key.return) {
      props.onDecision(APPROVAL_OPTIONS[selectedIndex]!.id);
      return;
    }

    if (key.escape) {
      props.onDecision("reject-once");
      return;
    }

    if (input === "1" || input === "2" || input === "3" || input === "4") {
      const option = APPROVAL_OPTIONS[Number(input) - 1];
      if (option) {
        props.onDecision(option.id);
      }
    }
  }, { isActive: Boolean(props.request) });

  if (!props.request) {
    return null;
  }

  return (
    <Pane
      title={`Permission Request · ${props.request.toolName}`}
      subtitle={props.request.title}
      accentColor={terminalUiTheme.colors.warning}
      footer="↑/↓ choose | Enter confirm | Esc reject"
    >
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        {props.request.summary}
      </Text>
      {props.request.details.map((detail) => (
        <Text key={detail} color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          {detail}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1} width="100%">
        {APPROVAL_OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={option.id} width="100%">
              <Text
                color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isSelected ? ">" : " "}
                {" "}
                [{index + 1}] {option.label} | {option.description}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Pane>
  );
}
