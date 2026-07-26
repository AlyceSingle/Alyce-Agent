import { extractCollapsedMessageText } from "../../../core/api/messageText.js";
import {
  formatPostEditSummary,
  type TurnDiffReport
} from "../../../core/diff/diffService.js";
import type { FileHistoryRestoreResult } from "../../../core/file-history/fileHistoryManager.js";
import { t } from "../../../i18n/index.js";
import type {
  SessionRuntime,
  VolatileConversationSnapshot
} from "../../../cli/sessionRuntime.js";
import {
  closeDialog,
  openRewindPickerDialog,
  replaceMessages,
  setContextBudget,
  setDraftInput,
  setStatusText,
  setTranscriptSticky
} from "../../state/actions.js";
import type { TerminalUiStore } from "../../state/store.js";
import type {
  RewindRestoreMode,
  TerminalUiMessage,
  TerminalUiRewindPoint
} from "../../state/types.js";
import { formatPostResponseFailure, type TurnCheckpoint } from "../agentTurnRunner.js";
import { createErrorMessage, createSystemMessage } from "../messageMapper.js";
import { formatRestoreConflictLines, isFileRestoreAvailable } from "./helpers.js";

const MAX_REWIND_POINTS = 100;

interface RewindPoint {
  id: string;
  turnId: string;
  input: string;
  createdAt: string;
  uiMessageCount: number;
  volatileSnapshot: VolatileConversationSnapshot;
  hasFileChanges: boolean;
  hasNonRestorableToolActivity: boolean;
  isRestoredFromHistory: boolean;
}

export interface RewindController {
  rollbackRuntimeConversationToCheckpoint: (checkpoint: TurnCheckpoint) => Promise<void>;
  rememberRewindPoint: (checkpoint: TurnCheckpoint) => void;
  finalizeTurnFileChangesForRewind: (
    checkpoint: TurnCheckpoint,
    postResponseFailures?: string[]
  ) => Promise<TurnDiffReport | null>;
  appendPostEditSummary: (report: TurnDiffReport | null | undefined) => boolean;
  openRewindSelector: () => void;
  restoreRewindPointById: (pointId: string, mode: RewindRestoreMode) => Promise<void>;
  rebuildRewindPointsFromCurrentConversation: (uiMessages: TerminalUiMessage[]) => void;
  clearRewindPoints: () => void;
}

export function createRewindController(deps: {
  runtime: SessionRuntime;
  store: TerminalUiStore;
  appendUiMessage: (message: TerminalUiMessage) => void;
  setDialogClosed: () => void;
  resetSessionHistoryPaging: () => void;
}): RewindController {
  const { runtime, store, appendUiMessage, setDialogClosed, resetSessionHistoryPaging } = deps;

  let rewindPoints: RewindPoint[] = [];

  const rollbackRuntimeConversationToCheckpoint = async (checkpoint: TurnCheckpoint) => {
    await runtime.restoreVolatileConversationSnapshot(checkpoint.volatileSnapshot);
  };

  const getAffectedRewindPoints = (target: RewindPoint) =>
    rewindPoints.filter((point) => point.uiMessageCount >= target.uiMessageCount);

  const hasRestorableFileSnapshot = (point: RewindPoint) =>
    point.hasFileChanges &&
    !point.isRestoredFromHistory &&
    isFileRestoreAvailable({
      hasTrackedChanges: runtime.hasTrackedFileChanges(point.turnId),
      canRestore: runtime.canRestoreFilesForTurn(point.turnId),
      alreadyRestored: runtime.isFilesAlreadyRestoredForTurn(point.turnId)
    });

  const toTerminalRewindPoint = (point: RewindPoint): TerminalUiRewindPoint => {
    const affected = getAffectedRewindPoints(point);
    const hasCodeChanges = affected.some((candidate) => candidate.hasFileChanges);
    const canRestoreFilesOnly =
      hasCodeChanges &&
      affected.every((candidate) => !candidate.hasFileChanges || hasRestorableFileSnapshot(candidate));
    const hasUnsafeToolActivity = affected.some((candidate) => candidate.hasNonRestorableToolActivity);
    const canRestoreCode = canRestoreFilesOnly && !hasUnsafeToolActivity;

    return {
      id: point.id,
      input: point.input,
      createdAt: point.createdAt,
      hasCodeChanges,
      canRestoreFilesOnly,
      canRestoreCode,
      hasUnsafeToolActivity,
      turnsRemoved: affected.length
    };
  };

  const buildRewindDialogPoints = () => [...rewindPoints].reverse().map(toTerminalRewindPoint);

  const trimRewindPoints = () => {
    while (rewindPoints.length > MAX_REWIND_POINTS) {
      const removed = rewindPoints.shift();
      if (removed && !removed.isRestoredFromHistory) {
        runtime.discardTurn(removed.turnId);
      }
    }
  };

  const rememberRewindPoint = (checkpoint: TurnCheckpoint) => {
    const hasFileChanges = runtime.hasTrackedFileChanges(checkpoint.turnId);
    const point: RewindPoint = {
      id: checkpoint.turnId,
      turnId: checkpoint.turnId,
      input: checkpoint.input,
      createdAt: checkpoint.createdAt,
      uiMessageCount: checkpoint.uiMessageCount,
      volatileSnapshot: checkpoint.volatileSnapshot,
      hasFileChanges,
      hasNonRestorableToolActivity: checkpoint.hasNonRestorableToolActivity,
      isRestoredFromHistory: false
    };

    rewindPoints = [
      ...rewindPoints.filter((candidate) => candidate.id !== point.id),
      point
    ].sort((a, b) => a.uiMessageCount - b.uiMessageCount);

    if (!hasFileChanges) {
      runtime.discardTurn(checkpoint.turnId);
    }

    trimRewindPoints();
  };

  const finalizeTurnFileChangesForRewind = async (
    checkpoint: TurnCheckpoint,
    postResponseFailures?: string[]
  ): Promise<TurnDiffReport | null> => {
    try {
      await runtime.finalizeTurnFileChanges(checkpoint.turnId);
      if (!runtime.hasTrackedFileChanges(checkpoint.turnId)) {
        return null;
      }

      return await runtime.getTurnDiff(checkpoint.turnId);
    } catch (error) {
      const message = formatPostResponseFailure("File diff snapshot failed", error);
      if (postResponseFailures) {
        postResponseFailures.push(message);
      } else {
        appendUiMessage(createErrorMessage(message));
      }
      return null;
    }
  };

  const appendPostEditSummary = (report: TurnDiffReport | null | undefined) => {
    if (!report) {
      return false;
    }

    const summary = formatPostEditSummary(report);
    if (!summary) {
      return false;
    }

    appendUiMessage(createSystemMessage(summary, "Diff"));
    return true;
  };

  const openRewindSelector = () => {
    const points = buildRewindDialogPoints();
    if (points.length === 0) {
      appendUiMessage(createSystemMessage("Nothing to revert yet.", "Revert"));
      return;
    }

    store.updateState((state) => openRewindPickerDialog(state, points));
  };

  const pruneRewindPointsFrom = (target: RewindPoint) => {
    const removed = getAffectedRewindPoints(target);
    for (const point of removed) {
      if (!point.isRestoredFromHistory) {
        runtime.discardTurn(point.turnId);
      }
    }
    rewindPoints = rewindPoints.filter((point) => point.uiMessageCount < target.uiMessageCount);
  };

  const restoreFilesForAffectedPoints = async (
    affected: RewindPoint[]
  ): Promise<Array<{ turnId: string; result: FileHistoryRestoreResult }>> => {
    const newestFirst = [...affected].sort((a, b) => b.uiMessageCount - a.uiMessageCount);
    const fileRestoreResults: Array<{ turnId: string; result: FileHistoryRestoreResult }> = [];

    for (const point of newestFirst) {
      if (!point.hasFileChanges || point.isRestoredFromHistory) {
        continue;
      }

      const result = await runtime.restoreFilesForTurn(point.turnId);
      if (result.missingSnapshot) {
        throw new Error(`File snapshots for turn ${point.turnId} are no longer available.`);
      }
      fileRestoreResults.push({ turnId: point.turnId, result });
    }

    return fileRestoreResults;
  };

  const restoreRewindPointById = async (pointId: string, mode: RewindRestoreMode) => {
    const target = rewindPoints.find((point) => point.id === pointId);
    if (!target) {
      appendUiMessage(createErrorMessage("That rewind point is no longer available."));
      setDialogClosed();
      return;
    }

    const view = toTerminalRewindPoint(target);
    if (mode === "files-only" && !view.canRestoreFilesOnly) {
      appendUiMessage(createErrorMessage("Tracked file restore is not available for that point."));
      setDialogClosed();
      return;
    }

    if (mode === "code-and-conversation" && !view.canRestoreCode) {
      appendUiMessage(createErrorMessage("Full revert is not available for that point."));
      setDialogClosed();
      return;
    }

    const affected = getAffectedRewindPoints(target);

    try {
      const fileRestoreResults =
        mode === "files-only" || mode === "code-and-conversation"
          ? await restoreFilesForAffectedPoints(affected)
          : [];

      if (mode === "files-only") {
        store.updateState((state) => setStatusText(closeDialog(state), t("status.reverted")));
        await runtime.recordSessionRewind({
          apiMessageCount: Math.max(0, runtime.messages.length - 1),
          uiMessageCount: store.getState().messages.length,
          sessionMemory: runtime.memoryService.getSessionMemory(),
          restoreMode: mode
        });
      } else {
        await runtime.restoreVolatileConversationSnapshot(target.volatileSnapshot);
        const baseMessages = store.getState().messages.slice(0, target.uiMessageCount);
        store.updateState((state) =>
          setDraftInput(
            setTranscriptSticky(
              setContextBudget(
                replaceMessages(setStatusText(closeDialog(state), t("status.reverted")), baseMessages),
                null
              ),
              true
            ),
            target.input
          )
        );
        resetSessionHistoryPaging();

        await runtime.recordSessionRewind({
          apiMessageCount: Math.max(0, runtime.messages.length - 1),
          uiMessageCount: target.uiMessageCount,
          sessionMemory: target.volatileSnapshot.memory.sessionMemory,
          restoredInput: target.input,
          restoreMode: mode
        });

        pruneRewindPointsFrom(target);
      }

      appendUiMessage(
        createSystemMessage(
          formatConversationRestoreResult({
            target,
            mode,
            affectedTurnCount: affected.length,
            fileRestoreResults
          }),
          "Revert"
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendUiMessage(createErrorMessage(`Failed to revert: ${message}`));
      store.updateState((state) => setStatusText(state, t("status.error")));
    }
  };

  const formatConversationRestoreResult = (options: {
    target: RewindPoint;
    mode: RewindRestoreMode;
    affectedTurnCount: number;
    fileRestoreResults: Array<{ turnId: string; result: FileHistoryRestoreResult }>;
  }) => {
    const fileTotals = options.fileRestoreResults.reduce(
      (totals, entry) => ({
        restored: totals.restored + entry.result.restored.length,
        removed: totals.removed + entry.result.removed.length,
        conflicts: totals.conflicts + entry.result.conflicts.length,
        alreadyRestored: totals.alreadyRestored + (entry.result.alreadyRestored ? 1 : 0)
      }),
      { restored: 0, removed: 0, conflicts: 0, alreadyRestored: 0 }
    );
    const conflictLines = options.fileRestoreResults.flatMap((entry) =>
      formatRestoreConflictLines(entry.result.conflicts, 5)
        .map((line) => `${line} (turn ${entry.turnId})`)
    );

    const lines = [
      options.mode === "code-and-conversation"
        ? fileTotals.conflicts > 0
          ? "Reverted safe tracked files and conversation history. Conflicting files were skipped."
          : "Reverted tracked files and conversation history."
        : options.mode === "files-only"
          ? fileTotals.conflicts > 0
            ? "Reverted safe tracked files only. Conversation was left unchanged. Conflicting files were skipped."
            : "Reverted tracked files only. Conversation was left unchanged."
          : "Reverted conversation history only. Files on disk were left unchanged.",
      `Turn: ${options.target.turnId}`,
      options.mode === "files-only"
        ? "Conversation: unchanged."
        : `Conversation turns removed: ${options.affectedTurnCount}`,
      options.mode === "code-and-conversation" || options.mode === "files-only"
        ? `Files restored: ${fileTotals.restored}; created files removed: ${fileTotals.removed}; conflicts skipped: ${fileTotals.conflicts}; already restored: ${fileTotals.alreadyRestored}`
        : "Files restored: 0; created files removed: 0"
    ];

    if (conflictLines.length > 0) {
      lines.push("", "Conflicts skipped:", ...conflictLines);
    }

    if (fileTotals.alreadyRestored > 0) {
      lines.push(
        "",
        `${fileTotals.alreadyRestored} affected turn(s) were already restored earlier and were skipped safely.`
      );
    }

    return lines.join("\n");
  };

  const rebuildRewindPointsFromCurrentConversation = (uiMessages: TerminalUiMessage[]) => {
    const apiUserMessages: Array<{ input: string; runtimeMessageCount: number }> = [];
    const currentSnapshot = runtime.createVolatileConversationSnapshot();
    for (let index = 1; index < runtime.messages.length; index += 1) {
      const message = runtime.messages[index];
      if (message?.role !== "user") {
        continue;
      }

      const input = extractCollapsedMessageText((message as { content?: unknown }).content);
      if (input) {
        apiUserMessages.push({
          input,
          runtimeMessageCount: index
        });
      }
    }

    const uiUserMessages = uiMessages
      .map((message, index) => ({ message, index }))
      .filter((entry) => entry.message.kind === "user");
    const count = Math.min(apiUserMessages.length, uiUserMessages.length);
    const rebuilt: RewindPoint[] = [];

    for (let index = 0; index < count; index += 1) {
      const apiUserMessage = apiUserMessages[index];
      const uiUserMessage = uiUserMessages[index];
      if (!apiUserMessage || !uiUserMessage) {
        continue;
      }

      rebuilt.push({
        id: `history-${uiUserMessage.message.id}`,
        turnId: `history-${uiUserMessage.message.id}`,
        input: apiUserMessage.input || uiUserMessage.message.content,
        createdAt: uiUserMessage.message.createdAt,
        uiMessageCount: uiUserMessage.index,
        volatileSnapshot: {
          ...currentSnapshot,
          messages: runtime.messages
            .slice(0, apiUserMessage.runtimeMessageCount)
            .map((message) => ({ ...message })),
          fileReadState: new Map(),
          memory: {
            ...currentSnapshot.memory,
            sessionMemory: null
          },
          compaction: null
        },
        hasFileChanges: false,
        hasNonRestorableToolActivity: false,
        isRestoredFromHistory: true
      });
    }

    rewindPoints = rebuilt;
    trimRewindPoints();
  };

  const clearRewindPoints = () => {
    for (const point of rewindPoints) {
      if (!point.isRestoredFromHistory) {
        runtime.discardTurn(point.turnId);
      }
    }
    rewindPoints = [];
  };

  return {
    rollbackRuntimeConversationToCheckpoint,
    rememberRewindPoint,
    finalizeTurnFileChangesForRewind,
    appendPostEditSummary,
    openRewindSelector,
    restoreRewindPointById,
    rebuildRewindPointsFromCurrentConversation,
    clearRewindPoints
  };
}
