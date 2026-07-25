import type { MemorySnapshot } from "../../core/memory/types.js";
import { getReplCommandHelpLines } from "../commandRouter.js";

export function getHelpText(currentModel: string) {
  return [
    "Commands:",
    ...getReplCommandHelpLines(currentModel),
    "",
    "Shortcuts:",
    "  Ctrl+X  Open settings",
    "  Esc     Interrupt while running; when idle, open revert history from empty input",
    "  Ctrl+C  Copy selection, otherwise clear input, otherwise quit",
    "  Ctrl+Q  Quit"
  ].join("\n");
}

export function formatMemorySnapshot(snapshot: MemorySnapshot, persistentPath: string) {
  const lines: string[] = ["=== Memory Snapshot ===", "Persistent file: " + persistentPath];

  lines.push("Session memory source: " + snapshot.sessionMemoryPath);
  if (!snapshot.sessionMemoryEnabled) {
    lines.push("Session memory summary: (disabled)");
  } else if (!snapshot.sessionMemory) {
    lines.push("Session memory summary: (not initialized yet)");
  } else {
    lines.push(
      "Session memory summary" +
        (snapshot.sessionMemory.updatedAt ? " (updated at " + snapshot.sessionMemory.updatedAt + ")" : "") +
        ":"
    );
    lines.push(snapshot.sessionMemory.markdown);
  }

  if (snapshot.session.length === 0) {
    lines.push("Session notes: (empty)");
  } else {
    lines.push("Session notes:");
    for (const entry of snapshot.session) {
      lines.push(`- [${entry.createdAt.slice(0, 10)}] (${entry.source}) ${entry.content}`);
    }
  }

  if (snapshot.persistent.length === 0) {
    lines.push("Persistent memory: (empty)");
  } else {
    lines.push("Persistent memory:");
    for (const entry of snapshot.persistent) {
      lines.push(`- [${entry.createdAt.slice(0, 10)}] (${entry.source}) ${entry.content}`);
    }
  }

  lines.push("=== End Memory Snapshot ===");
  return lines.join("\n");
}
