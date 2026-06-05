import { useEffect, useState } from "react";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useInput from "../runtime/ink-runtime/hooks/use-input.js";
import { terminalUiTheme } from "../theme/theme.js";
import type { PermissionDecision } from "../state/types.js";
import { Pane } from "./Pane.js";

type ApprovalOption = {
  id: PermissionDecision;
  label: string;
  description: string;
};

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
  {
    id: "full-access-session",
    label: "Switch to Full Access",
    description: "Use Full Access mode and approve this request."
  }
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
  {
    id: "full-access-session",
    label: "Switch to Full Access",
    description: "Use Full Access mode and approve this request."
  }
];

const MCP_TOOL_APPROVAL_OPTIONS: ApprovalOption[] = [
  {
    id: "allow-once",
    label: "Allow once",
    description: "Approve only this MCP tool call."
  },
  {
    id: "reject-once",
    label: "Reject once",
    description: "Deny only this MCP tool call."
  },
  {
    id: "allow-tool-session",
    label: "Allow tool for session",
    description: "Skip ordinary prompts for this MCP tool until restart."
  },
  {
    id: "ask-tool-persistent",
    label: "Always ask for tool",
    description: "Persist a user rule that keeps this MCP tool on ask for future calls."
  },
  {
    id: "allow-tool-persistent",
    label: "Always allow tool",
    description: "Persist a user rule that auto-allows this MCP tool."
  },
  {
    id: "deny-tool-persistent",
    label: "Disable tool",
    description: "Persist a user rule that denies this MCP tool."
  },
  {
    id: "full-access-session",
    label: "Switch to Full Access",
    description: "Use Full Access mode and approve this request."
  }
];

export function ApprovalDialog(props: {
  request: ToolApprovalRequest | null;
  onDecision: (decision: PermissionDecision) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const approvalOptions = props.request?.scope
    ? SCOPED_APPROVAL_OPTIONS
    : props.request?.kind === "mcp" && props.request.permission?.permission === "mcp.tool"
      ? MCP_TOOL_APPROVAL_OPTIONS
      : APPROVAL_OPTIONS;

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
