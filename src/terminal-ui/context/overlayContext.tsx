import { useEffect, useLayoutEffect } from "react";
import { useStdout } from "../runtime/ink.js";
import { invalidateInkPrevFrame } from "../runtime/instances.js";
import { setOverlayActive } from "../state/actions.js";
import { useTerminalUiSelector, useTerminalUiStore } from "../state/store.js";
import type { TerminalUiOverlayId } from "../state/types.js";

export function useRegisterOverlay(id: TerminalUiOverlayId, enabled = true) {
  const store = useTerminalUiStore();
  const { stdout } = useStdout();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    store.updateState((state) => setOverlayActive(state, id, true));
    return () => {
      store.updateState((state) => setOverlayActive(state, id, false));
    };
  }, [enabled, id, store]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    return () => {
      invalidateInkPrevFrame(stdout as NodeJS.WriteStream);
    };
  }, [enabled, stdout]);
}

export function useIsOverlayActive() {
  return useTerminalUiSelector((state) => state.activeOverlays.length > 0);
}
