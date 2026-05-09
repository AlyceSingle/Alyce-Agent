import { type Dispatch, type SetStateAction, useContext, useEffect, useState } from "react";
import { logLayoutTrace } from "../../utils/layoutTrace.js";
import { TerminalSizeContext } from "../components/TerminalSizeContext.js";
import useStdout from "./use-stdout.js";

type TerminalSize = {
  columns: number;
  rows: number;
};

function normalizeDimension(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(value as number));
}

function resolveTerminalSize(
  contextSize: TerminalSize | null,
  stdout: NodeJS.WriteStream | undefined
): TerminalSize {
  return {
    // Prefer live stdout dimensions first. TerminalSizeContext is updated via
    // App re-render and can briefly lag during resize bounce; using context
    // first can pin consumers to a stale smaller size until another input.
    columns: normalizeDimension(stdout?.columns ?? contextSize?.columns, 80),
    rows: normalizeDimension(stdout?.rows ?? contextSize?.rows, 24)
  };
}

function applyTerminalSize(
  source: "context-sync" | "stdout-resize",
  nextSize: TerminalSize,
  contextSize: TerminalSize | null,
  stdout: NodeJS.WriteStream | undefined,
  setTerminalSize: Dispatch<SetStateAction<TerminalSize>>
) {
  setTerminalSize((previous) => {
    if (previous.columns === nextSize.columns && previous.rows === nextSize.rows) {
      return previous;
    }

    logLayoutTrace("terminal-size:update", {
      source,
      previous: `${previous.columns}x${previous.rows}`,
      next: `${nextSize.columns}x${nextSize.rows}`,
      context: contextSize ? `${contextSize.columns}x${contextSize.rows}` : null,
      stdout: stdout ? `${stdout.columns ?? 0}x${stdout.rows ?? 0}` : null
    });
    return nextSize;
  });
}

export default function useTerminalSize(): TerminalSize {
  const contextSize = useContext(TerminalSizeContext);
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState<TerminalSize>(() =>
    resolveTerminalSize(contextSize, stdout)
  );

  useEffect(() => {
    const nextSize = resolveTerminalSize(contextSize, stdout);
    applyTerminalSize("context-sync", nextSize, contextSize, stdout, setTerminalSize);
  }, [contextSize?.columns, contextSize?.rows, stdout]);

  useEffect(() => {
    if (!stdout?.isTTY) {
      return;
    }

    const handleResize = () => {
      const nextSize = resolveTerminalSize(contextSize, stdout);
      applyTerminalSize("stdout-resize", nextSize, contextSize, stdout, setTerminalSize);
    };

    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [contextSize?.columns, contextSize?.rows, stdout]);

  return terminalSize;
}
