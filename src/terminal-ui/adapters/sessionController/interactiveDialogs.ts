import { TurnInterruptedError } from "../../../core/abort.js";
import type {
  McpElicitationRequest,
  McpElicitationResponse
} from "../../../mcp/types.js";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse
} from "../../../tools/types.js";
import {
  openMcpElicitationDialog,
  openQuestionDialog
} from "../../state/actions.js";
import type { TerminalUiStore } from "../../state/store.js";
import type { TurnCheckpoint } from "../agentTurnRunner.js";

export interface InteractiveDialogController {
  askUserQuestions: (
    request: AskUserQuestionRequest,
    options?: { signal?: AbortSignal }
  ) => Promise<AskUserQuestionResponse>;
  requestMcpElicitation: (
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<McpElicitationResponse>;
  respondToQuestion: (response: AskUserQuestionResponse | null) => void;
  respondToMcpElicitation: (response: McpElicitationResponse) => void;
  hasPendingInteractiveDialog: () => boolean;
}

export function createInteractiveDialogController(deps: {
  store: TerminalUiStore;
  setDialogClosed: () => void;
  hasPendingApproval: () => boolean;
  getActiveTurn: () => TurnCheckpoint | null;
}): InteractiveDialogController {
  const { store, setDialogClosed, hasPendingApproval, getActiveTurn } = deps;

  let pendingQuestionResolver: ((response: AskUserQuestionResponse | null) => void) | null = null;
  let pendingMcpElicitationResolver: ((response: McpElicitationResponse) => void) | null = null;

  const askUserQuestions = async (
    request: AskUserQuestionRequest,
    options: { signal?: AbortSignal } = {}
  ) => {
    if (hasPendingApproval() || pendingQuestionResolver || pendingMcpElicitationResolver) {
      throw new Error("Another interactive dialog is already pending.");
    }

    store.updateState((state) => openQuestionDialog(state, request));

    return new Promise<AskUserQuestionResponse>((resolve, reject) => {
      const cleanup = () => {
        options.signal?.removeEventListener("abort", handleAbort);
      };

      const settle = (response: AskUserQuestionResponse | null) => {
        pendingQuestionResolver = null;
        cleanup();
        setDialogClosed();

        if (!response) {
          const activeTurn = getActiveTurn();
          if (activeTurn && !activeTurn.controller.signal.aborted) {
            activeTurn.userCancelled = true;
            activeTurn.controller.abort("user-cancel");
          }
          reject(new TurnInterruptedError("user-cancel", "Request interrupted by user"));
          return;
        }

        resolve(response);
      };

      const handleAbort = () => {
        if (!pendingQuestionResolver) {
          cleanup();
          return;
        }

        pendingQuestionResolver = null;
        cleanup();
        setDialogClosed();
        reject(new TurnInterruptedError("user-cancel", "Request interrupted by user"));
      };

      if (options.signal?.aborted) {
        handleAbort();
        return;
      }

      pendingQuestionResolver = settle;
      options.signal?.addEventListener("abort", handleAbort, { once: true });
    });
  };

  const requestMcpElicitation = async (
    request: McpElicitationRequest,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ) => {
    if (hasPendingApproval() || pendingQuestionResolver || pendingMcpElicitationResolver) {
      throw new Error("Another interactive dialog is already pending.");
    }

    store.updateState((state) => openMcpElicitationDialog(state, request));

    return new Promise<McpElicitationResponse>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = () => {
        options.signal?.removeEventListener("abort", handleAbort);
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      const settle = (response: McpElicitationResponse) => {
        pendingMcpElicitationResolver = null;
        cleanup();
        setDialogClosed();
        resolve(response);
      };

      const handleAbort = () => {
        if (!pendingMcpElicitationResolver) {
          cleanup();
          return;
        }

        pendingMcpElicitationResolver = null;
        cleanup();
        setDialogClosed();
        reject(new TurnInterruptedError("user-cancel", "Request interrupted by user"));
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (!pendingMcpElicitationResolver) {
            return;
          }

          pendingMcpElicitationResolver = null;
          cleanup();
          setDialogClosed();
          resolve({ action: "cancel" });
        }, options.timeoutMs);
      }

      if (options.signal?.aborted) {
        handleAbort();
        return;
      }

      pendingMcpElicitationResolver = settle;
      options.signal?.addEventListener("abort", handleAbort, { once: true });
    });
  };

  return {
    askUserQuestions,
    requestMcpElicitation,
    respondToQuestion: (response) => {
      pendingQuestionResolver?.(response);
    },
    respondToMcpElicitation: (response) => {
      pendingMcpElicitationResolver?.(response);
    },
    hasPendingInteractiveDialog: () =>
      pendingQuestionResolver !== null || pendingMcpElicitationResolver !== null
  };
}
