import { useEffect, useMemo, useState } from "react";
import type {
  RewindRestoreMode,
  TerminalUiRewindPoint
} from "../state/types.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useInput from "../runtime/ink-runtime/hooks/use-input.js";
import { terminalUiTheme } from "../theme/theme.js";
import { Pane } from "./Pane.js";

const VISIBLE_COUNT = 7;

type ConfirmOption = {
  mode: RewindRestoreMode | "back";
  label: string;
  description: string;
};

export function RewindPickerDialog(props: {
  points: TerminalUiRewindPoint[];
  onRestore: (pointId: string, mode: RewindRestoreMode) => void;
  onCancel: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmingPointId, setConfirmingPointId] = useState<string | null>(null);
  const [confirmIndex, setConfirmIndex] = useState(0);
  const selectedPoint = props.points[selectedIndex] ?? null;
  const confirmingPoint =
    confirmingPointId === null
      ? null
      : props.points.find((point) => point.id === confirmingPointId) ?? null;

  useRegisterOverlay("rewind-picker", props.points.length > 0);

  useEffect(() => {
    setSelectedIndex(0);
    setConfirmingPointId(null);
    setConfirmIndex(0);
  }, [props.points]);

  const confirmOptions = useMemo(() => {
    if (!confirmingPoint) {
      return [];
    }

    const options: ConfirmOption[] = [];
    if (confirmingPoint.canRestoreCode) {
      options.push({
        mode: "code-and-conversation",
        label: "Restore code and conversation",
        description: "Restore tracked file edits and remove later messages."
      });
    }

    if (confirmingPoint.canRestoreFilesOnly) {
      options.push({
        mode: "files-only",
        label: "Restore code only",
        description: "Restore tracked file edits and keep the conversation unchanged."
      });
    }

    options.push({
      mode: "conversation",
      label: "Restore conversation",
      description: confirmingPoint.hasCodeChanges
        ? "Remove later messages only; current file changes stay on disk."
        : "Remove later messages and put this prompt back in the input."
    });

    options.push({
      mode: "back",
      label: "Back",
      description: "Return to the rewind list."
    });

    return options;
  }, [confirmingPoint]);

  useInput((input, key) => {
    if (props.points.length === 0) {
      return;
    }

    if (input.toLowerCase() === "q" || (key.ctrl && input.toLowerCase() === "c")) {
      props.onCancel();
      return;
    }

    if (confirmingPoint) {
      if (key.escape) {
        setConfirmingPointId(null);
        setConfirmIndex(0);
        return;
      }

      if (key.upArrow) {
        setConfirmIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setConfirmIndex((current) => Math.min(confirmOptions.length - 1, current + 1));
        return;
      }

      if (key.return) {
        const option = confirmOptions[confirmIndex];
        if (!option || option.mode === "back") {
          setConfirmingPointId(null);
          setConfirmIndex(0);
          return;
        }

        props.onRestore(confirmingPoint.id, option.mode);
      }
      return;
    }

    if (key.escape) {
      props.onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(props.points.length - 1, current + 1));
      return;
    }

    if (key.return) {
      if (!selectedPoint) {
        return;
      }

      setConfirmingPointId(selectedPoint.id);
      setConfirmIndex(0);
    }
  }, { isActive: props.points.length > 0 });

  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(VISIBLE_COUNT / 2), props.points.length - VISIBLE_COUNT)
  );
  const visiblePoints = props.points.slice(startIndex, startIndex + VISIBLE_COUNT);

  const footer = confirmingPoint
    ? "↑/↓ choose | Enter restore | Esc back | q cancel"
    : "↑/↓ choose | Enter options | Esc cancel | q cancel";

  return (
    <Pane
      title="Revert"
      subtitle={`${props.points.length} restore point${props.points.length === 1 ? "" : "s"}`}
      accentColor={terminalUiTheme.colors.warning}
      footer={footer}
    >
      <Box flexDirection="column" width="100%">
        {confirmingPoint ? (
          <ConfirmView
            point={confirmingPoint}
            options={confirmOptions}
            selectedIndex={confirmIndex}
          />
        ) : (
          <>
            <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
              Choose a restore point, then decide whether to restore code, conversation, or both.
            </Text>
            {visiblePoints.map((point, index) => {
              const actualIndex = startIndex + index;
              const isSelected = actualIndex === selectedIndex;
              const codeLabel = point.hasCodeChanges
                ? point.canRestoreCode
                  ? "full revert available"
                  : point.canRestoreFilesOnly
                    ? "code restore only"
                    : "conversation only"
                : "conversation restore";

              return (
                <Box key={point.id} flexDirection="column" width="100%">
                  <Text
                    color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                    backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                    wrap="truncate-end"
                  >
                    {isSelected ? ">" : " "}
                    {" "}
                    {point.input}
                  </Text>
                  <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
                    {"  "}
                    {formatPointTime(point.createdAt)} | removes {point.turnsRemoved} turn
                    {point.turnsRemoved === 1 ? "" : "s"} | {codeLabel}
                  </Text>
                </Box>
              );
            })}
          </>
        )}
      </Box>
    </Pane>
  );
}

function ConfirmView(props: {
  point: TerminalUiRewindPoint;
  options: ConfirmOption[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
        Restore to before:
      </Text>
      <Box flexDirection="column" width="100%">
        <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
          {props.point.input}
        </Text>
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          {formatPointTime(props.point.createdAt)} | removes {props.point.turnsRemoved} turn
          {props.point.turnsRemoved === 1 ? "" : "s"}
        </Text>
      </Box>
      {props.point.hasUnsafeToolActivity && !props.point.canRestoreCode ? (
        <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
          Full revert is unavailable because some later side effects cannot be reversed. You can still restore tracked files only when snapshots are available.
        </Text>
      ) : null}
      {!props.point.canRestoreFilesOnly && props.point.hasCodeChanges ? (
        <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
          Tracked file restore is unavailable because some snapshots were already restored or pruned.
        </Text>
      ) : null}
      <Box flexDirection="column" width="100%">
        {props.options.map((option, index) => {
          const isSelected = index === props.selectedIndex;
          return (
            <Box key={option.mode} flexDirection="column" width="100%">
              <Text
                color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isSelected ? ">" : " "}
                {" "}
                {option.label}
              </Text>
              <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
                {"  "}
                {option.description}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function formatPointTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
