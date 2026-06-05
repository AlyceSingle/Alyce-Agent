import { useEffect, useState } from "react";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { t } from "../../i18n/index.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useInput from "../runtime/ink-runtime/hooks/use-input.js";
import { terminalUiTheme } from "../theme/theme.js";
import type { PermissionDecision } from "../state/types.js";
import { Pane } from "./Pane.js";

type ApprovalOption = {
  id: PermissionDecision;
  labelKey: string;
  descriptionKey: string;
};

const APPROVAL_OPTIONS: ApprovalOption[] = [
  {
    id: "allow-once",
    labelKey: "approvalDialog.option.allowOnce.label",
    descriptionKey: "approvalDialog.option.allowOnce.description"
  },
  {
    id: "reject-once",
    labelKey: "approvalDialog.option.rejectOnce.label",
    descriptionKey: "approvalDialog.option.rejectOnce.description"
  },
  {
    id: "allow-kind-session",
    labelKey: "approvalDialog.option.allowKindSession.label",
    descriptionKey: "approvalDialog.option.allowKindSession.description"
  },
  {
    id: "full-access-session",
    labelKey: "approvalDialog.option.fullAccessSession.label",
    descriptionKey: "approvalDialog.option.fullAccessSession.description"
  }
];

const SCOPED_APPROVAL_OPTIONS: ApprovalOption[] = [
  {
    id: "allow-once",
    labelKey: "approvalDialog.option.allowOnce.label",
    descriptionKey: "approvalDialog.option.allowOnce.description"
  },
  {
    id: "reject-once",
    labelKey: "approvalDialog.option.rejectOnce.label",
    descriptionKey: "approvalDialog.option.rejectOnce.description"
  },
  {
    id: "allow-scope-session",
    labelKey: "approvalDialog.option.allowScopeSession.label",
    descriptionKey: "approvalDialog.option.allowScopeSession.description"
  },
  {
    id: "full-access-session",
    labelKey: "approvalDialog.option.fullAccessSession.label",
    descriptionKey: "approvalDialog.option.fullAccessSession.description"
  }
];

const MCP_TOOL_APPROVAL_OPTIONS: ApprovalOption[] = [
  {
    id: "allow-once",
    labelKey: "approvalDialog.option.allowOnce.label",
    descriptionKey: "approvalDialog.option.allowOnce.mcpDescription"
  },
  {
    id: "reject-once",
    labelKey: "approvalDialog.option.rejectOnce.label",
    descriptionKey: "approvalDialog.option.rejectOnce.mcpDescription"
  },
  {
    id: "allow-tool-session",
    labelKey: "approvalDialog.option.allowToolSession.label",
    descriptionKey: "approvalDialog.option.allowToolSession.description"
  },
  {
    id: "ask-tool-persistent",
    labelKey: "approvalDialog.option.askToolPersistent.label",
    descriptionKey: "approvalDialog.option.askToolPersistent.description"
  },
  {
    id: "allow-tool-persistent",
    labelKey: "approvalDialog.option.allowToolPersistent.label",
    descriptionKey: "approvalDialog.option.allowToolPersistent.description"
  },
  {
    id: "deny-tool-persistent",
    labelKey: "approvalDialog.option.denyToolPersistent.label",
    descriptionKey: "approvalDialog.option.denyToolPersistent.description"
  },
  {
    id: "full-access-session",
    labelKey: "approvalDialog.option.fullAccessSession.label",
    descriptionKey: "approvalDialog.option.fullAccessSession.description"
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
      title={t("approvalDialog.title", { toolName: props.request.toolName })}
      subtitle={props.request.title}
      accentColor={terminalUiTheme.colors.warning}
      footer={t("approvalDialog.footer", { count: approvalOptions.length })}
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
                [{index + 1}] {t(option.labelKey)} | {t(option.descriptionKey)}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Pane>
  );
}
