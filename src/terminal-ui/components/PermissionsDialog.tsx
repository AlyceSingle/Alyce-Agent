import { useEffect, useState } from "react";
import type { ApprovalMode } from "../../config/runtime.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useInput from "../runtime/ink-runtime/hooks/use-input.js";
import { terminalUiTheme } from "../theme/theme.js";
import { Pane } from "./Pane.js";

const PERMISSION_MODE_OPTIONS: Array<{
  id: ApprovalMode;
  label: string;
  description: string;
}> = [
  {
    id: "read-only",
    label: "Read Only",
    description:
      "Codex can read files in the current workspace. Approval is required to edit files or access the internet."
  },
  {
    id: "default",
    label: "Default",
    description:
      "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files."
  },
  {
    id: "auto-review",
    label: "Auto-review",
    description:
      "Same workspace-write permissions as Default, but eligible on-request approvals are routed through the auto-reviewer subagent."
  },
  {
    id: "full-access",
    label: "Full Access",
    description:
      "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using."
  }
];

export function PermissionsDialog(props: {
  mode: ApprovalMode;
  onSelect: (mode: ApprovalMode) => void;
  onCancel: () => void;
}) {
  const initialIndex = Math.max(
    0,
    PERMISSION_MODE_OPTIONS.findIndex((option) => option.id === props.mode)
  );
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  useRegisterOverlay("permissions", true);

  useEffect(() => {
    setSelectedIndex(initialIndex);
  }, [initialIndex]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(PERMISSION_MODE_OPTIONS.length - 1, current + 1));
      return;
    }

    if (key.escape) {
      props.onCancel();
      return;
    }

    if (key.return) {
      props.onSelect(PERMISSION_MODE_OPTIONS[selectedIndex]?.id ?? props.mode);
      return;
    }

    const optionIndex = /^\d+$/.test(input) ? Number.parseInt(input, 10) - 1 : -1;
    const option = PERMISSION_MODE_OPTIONS[optionIndex];
    if (option) {
      props.onSelect(option.id);
    }
  }, { isActive: true });

  return (
    <Pane
      title="Permissions"
      subtitle="Choose approval mode"
      accentColor={terminalUiTheme.colors.chrome}
      footer="↑/↓ choose | 1-4 shortcut | Enter confirm | Esc close"
    >
      <Box flexDirection="column" width="100%">
        {PERMISSION_MODE_OPTIONS.map((option, index) => {
          const isSelected = selectedIndex === index;
          const isCurrent = props.mode === option.id;
          const label = `${option.label}${isCurrent ? " (current)" : ""}`;
          const marker = isSelected ? ">" : " ";
          return (
            <Box key={option.id} width="100%" flexDirection="column" marginBottom={1}>
              <Text
                color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {marker} {index + 1}. {label}
              </Text>
              <Box paddingLeft={4} width="100%">
                <Text
                  color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.subtle}
                  wrap="wrap"
                >
                  {option.description}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Pane>
  );
}
