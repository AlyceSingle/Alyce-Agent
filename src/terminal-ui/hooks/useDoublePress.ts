import { useCallback, useEffect, useRef } from "react";

export const DOUBLE_PRESS_TIMEOUT_MS = 800;

export function useDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
  onFirstPress?: () => void
) {
  const lastPressRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingRef = useRef(false);

  const setPendingSafe = useCallback((pending: boolean) => {
    if (pendingRef.current === pending) {
      return;
    }

    pendingRef.current = pending;
    setPending(pending);
  }, [setPending]);

  const clearTimeoutSafe = useCallback(() => {
    if (!timeoutRef.current) {
      return;
    }

    clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const reset = useCallback(() => {
    clearTimeoutSafe();
    setPendingSafe(false);
    lastPressRef.current = 0;
  }, [clearTimeoutSafe, setPendingSafe]);

  useEffect(() => {
    return () => {
      clearTimeoutSafe();
    };
  }, [clearTimeoutSafe]);

  const trigger = useCallback(() => {
    const now = Date.now();
    const isDoublePress =
      now - lastPressRef.current <= DOUBLE_PRESS_TIMEOUT_MS &&
      timeoutRef.current !== null;

    lastPressRef.current = now;

    if (isDoublePress) {
      clearTimeoutSafe();
      setPendingSafe(false);
      onDoublePress();
      return;
    }

    onFirstPress?.();
    setPendingSafe(true);
    clearTimeoutSafe();
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setPendingSafe(false);
    }, DOUBLE_PRESS_TIMEOUT_MS);
  }, [clearTimeoutSafe, onDoublePress, onFirstPress, setPendingSafe]);

  return {
    trigger,
    reset
  };
}
