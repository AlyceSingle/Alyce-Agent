import type { ParsedCommand } from "./types.js";
import { createMigrationCommandError } from "./types.js";

// Session commands: /revert, /diff, /resume, /sessions, /memory, /usage,
// /remember, and /context (plus removed-command migrations).
export function parseSessionCommand(input: string): ParsedCommand | null {
  if (input === "/rewind" || input.startsWith("/rewind ")) {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /revert to open revert history."
    );
  }

  const revertCommand = parseRevertCommand(input);
  if (revertCommand) {
    return revertCommand;
  }

  const diffCommand = parseDiffCommand(input);
  if (diffCommand) {
    return diffCommand;
  }

  if (input === "/resume") {
    return { type: "open-session-picker" };
  }

  if (input.startsWith("/resume ")) {
    const query = input.slice(8).trim();
    if (!query) {
      return {
        type: "command-error",
        input,
        message: "Missing session ID or search text to resume."
      };
    }

    return { type: "resume-session", query };
  }

  if (input === "/sessions") {
    return { type: "sessions-list" };
  }

  const memoryCommand = parseMemoryCommand(input);
  if (memoryCommand) {
    return memoryCommand;
  }

  if (input === "/usage") {
    return { type: "usage-view" };
  }

  if (input.startsWith("/usage ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported /usage argument. Use /usage."
    };
  }

  if (input === "/remember") {
    return {
      type: "command-error",
      input,
      message: "Missing memory content."
    };
  }

  if (input.startsWith("/remember ")) {
    const raw = input.slice(10).trim();
    if (!raw) {
      return {
        type: "command-error",
        input,
        message: "Missing memory content."
      };
    }

    // /remember --session only writes to in-session memory.
    if (raw.startsWith("--session ")) {
      const note = raw.slice(10).trim();
      if (!note) {
        return {
          type: "command-error",
          input,
          message: "Missing session memory content."
        };
      }

      return {
        type: "remember",
        note,
        persist: false
      };
    }

    return {
      type: "remember",
      note: raw,
      persist: true
    };
  }

  if (input === "/context") {
    return { type: "context-preview" };
  }

  if (input.startsWith("/context ")) {
    return {
      type: "context-preview",
      nextUserInput: input.slice(9)
    };
  }

  return null;
}

function parseRevertCommand(
  input: string
): Extract<ParsedCommand, { type: "revert" | "command-error" }> | null {
  if (input !== "/revert" && !input.startsWith("/revert ")) {
    return null;
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return {
      type: "revert"
    };
  }

  return createMigrationCommandError(
    input,
    "Revert flags were removed. Use /revert and choose an action from the revert history."
  );
}

function parseDiffCommand(
  input: string
): Extract<ParsedCommand, { type: "diff-view" | "command-error" }> | null {
  if (input !== "/diff" && !input.startsWith("/diff ")) {
    return null;
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return {
      type: "diff-view",
      target: "overview"
    };
  }

  if (tokens.length !== 2) {
    return {
      type: "command-error",
      input,
      message: "Unsupported /diff argument. Use /diff, /diff last, /diff current, or /diff <turn>."
    };
  }

  if (tokens[1] === "last") {
    return {
      type: "diff-view",
      target: "last"
    };
  }

  if (tokens[1] === "current") {
    return {
      type: "diff-view",
      target: "current"
    };
  }

  return {
    type: "diff-view",
    target: {
      turnId: tokens[1]
    }
  };
}

function parseMemoryCommand(
  input: string
): Extract<ParsedCommand, { type: "memory-view" | "memory-clear" | "command-error" }> | null {
  if (input !== "/memory" && !input.startsWith("/memory ")) {
    return null;
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return { type: "memory-view" };
  }

  if (tokens[1] !== "clear") {
    return {
      type: "command-error",
      input,
      message: "Unsupported /memory subcommand."
    };
  }

  if (tokens.length === 2) {
    return {
      type: "memory-clear",
      clearPersistent: false
    };
  }

  if (tokens.length === 3 && tokens[2] === "--all") {
    return {
      type: "memory-clear",
      clearPersistent: true
    };
  }

  return {
    type: "command-error",
    input,
    message: "Unsupported /memory clear argument."
  };
}
