import type { ParsedCommand } from "./types.js";
import { createMigrationCommandError } from "./types.js";

// Task commands: /tasks subcommands.
export function parseTasksCommand(
  input: string
): Extract<ParsedCommand, { type: "tasks-list" | "tasks-get" | "tasks-stop" | "tasks-cleanup" | "command-error" }> | null {
  if (input !== "/tasks" && !input.startsWith("/tasks ")) {
    return null;
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return {
      type: "tasks-list"
    };
  }

  if (tokens[1] === "log") {
    return createMigrationCommandError(
      input,
      tokens.length === 3
        ? `This command was removed. Use /tasks get ${tokens[2]!}.`
        : "This command was removed. Use /tasks get <id>."
    );
  }

  if (tokens[1] === "get") {
    if (tokens.length !== 3) {
      return {
        type: "command-error",
        input,
        message: "Missing task id. Use /tasks get <id>."
      };
    }

    return {
      type: "tasks-get",
      taskId: tokens[2]!
    };
  }

  if (tokens[1] === "stop") {
    if (tokens.length !== 3) {
      return {
        type: "command-error",
        input,
        message: "Missing task id. Use /tasks stop <id>."
      };
    }

    return {
      type: "tasks-stop",
      taskId: tokens[2]!
    };
  }

  if (tokens[1] === "resume") {
    return {
      type: "command-error",
      input,
      message: "/tasks resume is not supported yet. Use AgentTool with an existing task_id when a resumable task model is available."
    };
  }

  if (tokens[1] !== "cleanup") {
    return {
      type: "command-error",
      input,
      message: "Unsupported /tasks subcommand."
    };
  }

  if (tokens.length === 2) {
    return {
      type: "tasks-cleanup",
      apply: false
    };
  }

  if (tokens.length === 3 && tokens[2] === "--apply") {
    return {
      type: "tasks-cleanup",
      apply: true
    };
  }

  return {
    type: "command-error",
    input,
    message: "Unsupported /tasks cleanup argument."
  };
}

// Background process commands: /processes and /stop (plus the removed /bg).
export function parseProcessCommand(
  input: string
): Extract<ParsedCommand, { type: "processes-list" | "process-stop" | "command-error" }> | null {
  if (input === "/bg" || input.startsWith("/bg ")) {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /processes."
    );
  }

  if (input === "/processes") {
    return {
      type: "processes-list"
    };
  }

  if (input.startsWith("/processes ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported background process list argument. Use /processes."
    };
  }

  if (input === "/stop" || input.startsWith("/stop ")) {
    const tokens = input.split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) {
      return {
        type: "command-error",
        input,
        message: "Missing process id. Use /stop <id>."
      };
    }

    return {
      type: "process-stop",
      processId: tokens[1]!
    };
  }

  return null;
}
