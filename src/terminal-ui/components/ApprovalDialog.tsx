import { useEffect, useState } from "react";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { Box, Text, useInput } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import type { PermissionDecision } from "../state/types.js";
import { Pane } from "./Pane.js";

type ApprovalOption = {
  id: PermissionDecision;
  label: string;
  description: string;
};

const SESSION_APPROVAL_OPTIONS: ApprovalOption[] = [
  {
    id: "auto-approve-session",
    label: "Auto approve this session",
    description: "Disable ordinary approval prompts for this run."
  },
  {
    id: "full-approve-session",
    label: "Fully approve this session",
    description: "Skip all approval prompts for this run, including forced prompts."
  }
];

const APPROVAL_OPTIONS: ApprovalOption[] = [
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
    description: "Skip ordinary prompts for this permission kind until restart."
  },
  ...SESSION_APPROVAL_OPTIONS
];

const SCOPED_APPROVAL_OPTIONS: ApprovalOption[] = [
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
    id: "allow-scope-session",
    label: "Allow directory for session",
    description: "Skip ordinary prompts for this external directory until restart."
  },
  ...SESSION_APPROVAL_OPTIONS
];

export function ApprovalDialog(props: {
  request: ToolApprovalRequest | null;
  onDecision: (decision: PermissionDecision) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const approvalOptions = props.request?.scope ? SCOPED_APPROVAL_OPTIONS : APPROVAL_OPTIONS;

  useRegisterOverlay("permission", Boolean(props.request));

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.request]);

  useInput((input, key) => {
    if (!props.request) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(approvalOptions.length - 1, current + 1));
      return;
    }

    if (key.return) {
      const selectedOption = approvalOptions[selectedIndex] ?? approvalOptions[0];
      if (selectedOption) {
        props.onDecision(selectedOption.id);
      }
      return;
    }

    if (key.escape) {
      props.onDecision("reject-once");
      return;
    }

    const optionIndex = /^\d+$/.test(input) ? Number.parseInt(input, 10) - 1 : -1;
    if (optionIndex >= 0) {
      const option = approvalOptions[optionIndex];
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
      footer={`↑/↓ choose | 1-${approvalOptions.length} shortcut | Enter confirm | Esc reject`}
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
        {approvalOptions.map((option, index) => {
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
