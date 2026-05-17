export type ReplCommandDefinition = {
  command: string;
  usage: string;
  description: string;
  completion: string;
};

export const REPL_COMMAND_DEFINITIONS: ReplCommandDefinition[] = [
  {
    command: "/help",
    usage: "/help",
    description: "Show this help",
    completion: "/help"
  },
  {
    command: "/doctor",
    usage: "/doctor",
    description: "Run local health checks",
    completion: "/doctor"
  },
  {
    command: "/plan",
    usage: "/plan",
    description: "Enter read-only planning mode",
    completion: "/plan"
  },
  {
    command: "/plan exit",
    usage: "/plan exit",
    description: "Exit planning mode after confirmation",
    completion: "/plan exit"
  },
  {
    command: "/build",
    usage: "/build",
    description: "Exit planning mode after confirmation",
    completion: "/build"
  },
  {
    command: "/settings",
    usage: "/settings",
    description: "Open runtime settings",
    completion: "/settings"
  },
  {
    command: "/permissions",
    usage: "/permissions",
    description: "Switch approval and access mode",
    completion: "/permissions"
  },
  {
    command: "/setup",
    usage: "/setup",
    description: "Open provider connection picker",
    completion: "/setup"
  },
  {
    command: "/connect",
    usage: "/connect",
    description: "Open provider connection picker",
    completion: "/connect "
  },
  {
    command: "/logout",
    usage: "/logout <provider>",
    description: "Remove a provider credential",
    completion: "/logout "
  },
  {
    command: "/clear",
    usage: "/clear",
    description: "Clear chat history",
    completion: "/clear"
  },
  {
    command: "/rewind",
    usage: "/rewind",
    description: "Restore to a previous prompt",
    completion: "/rewind"
  },
  {
    command: "/revert",
    usage: "/revert",
    description: "Revert the latest Alyce turn with confirmation",
    completion: "/revert"
  },
  {
    command: "/revert --files-only",
    usage: "/revert --files-only",
    description: "Revert the latest Alyce turn file changes only",
    completion: "/revert --files-only"
  },
  {
    command: "/revert --conversation-only",
    usage: "/revert --conversation-only",
    description: "Rewind conversation to the latest Alyce turn only",
    completion: "/revert --conversation-only"
  },
  {
    command: "/diff",
    usage: "/diff",
    description: "Show last Alyce turn and working tree diff summaries",
    completion: "/diff"
  },
  {
    command: "/diff last",
    usage: "/diff last",
    description: "Show the latest Alyce turn diff",
    completion: "/diff last"
  },
  {
    command: "/diff current",
    usage: "/diff current",
    description: "Show the current git working tree diff",
    completion: "/diff current"
  },
  {
    command: "/resume",
    usage: "/resume [id|text]",
    description: "Resume a previous project session",
    completion: "/resume "
  },
  {
    command: "/sessions",
    usage: "/sessions",
    description: "List saved project sessions",
    completion: "/sessions"
  },
  {
    command: "/remember",
    usage: "/remember <text>",
    description: "Save note to session and persistent memory",
    completion: "/remember "
  },
  {
    command: "/remember --session",
    usage: "/remember --session <text>",
    description: "Save note to session notes only",
    completion: "/remember --session "
  },
  {
    command: "/memory",
    usage: "/memory",
    description: "Show memory snapshot",
    completion: "/memory"
  },
  {
    command: "/memory clear",
    usage: "/memory clear",
    description: "Clear session memory",
    completion: "/memory clear"
  },
  {
    command: "/memory clear --all",
    usage: "/memory clear --all",
    description: "Clear session and persistent memory",
    completion: "/memory clear --all"
  },
  {
    command: "/tasks",
    usage: "/tasks",
    description: "List current-session background subagent tasks",
    completion: "/tasks"
  },
  {
    command: "/tasks get",
    usage: "/tasks get <id>",
    description: "Show background task details",
    completion: "/tasks get "
  },
  {
    command: "/tasks log",
    usage: "/tasks log <id>",
    description: "Alias for /tasks get <id>",
    completion: "/tasks log "
  },
  {
    command: "/tasks stop",
    usage: "/tasks stop <id>",
    description: "Stop a running background task",
    completion: "/tasks stop "
  },
  {
    command: "/tasks cleanup",
    usage: "/tasks cleanup [--apply]",
    description: "Scan or clean stale subagent storage artifacts",
    completion: "/tasks cleanup"
  },
  {
    command: "/tasks cleanup --apply",
    usage: "/tasks cleanup --apply",
    description: "Clean stale subagent storage artifacts",
    completion: "/tasks cleanup --apply"
  },
  {
    command: "/processes",
    usage: "/processes",
    description: "List managed background processes",
    completion: "/processes"
  },
  {
    command: "/bg",
    usage: "/bg",
    description: "Alias for /processes",
    completion: "/bg"
  },
  {
    command: "/stop",
    usage: "/stop <id>",
    description: "Stop a managed background process",
    completion: "/stop "
  },
  {
    command: "/usage",
    usage: "/usage",
    description: "Show session token, duration, and estimated cost usage",
    completion: "/usage"
  },
  {
    command: "/context",
    usage: "/context [text]",
    description: "Show full next-turn AI context payload",
    completion: "/context"
  },
  {
    command: "/model",
    usage: "/model [provider/model]",
    description: "Open model picker or switch provider/model",
    completion: "/model"
  },
  {
    command: "/models",
    usage: "/models",
    description: "List configured providers and models",
    completion: "/models"
  },
  {
    command: "/add-dir",
    usage: "/add-dir <path>",
    description: "Allow an extra directory for this session",
    completion: "/add-dir "
  },
  {
    command: "/add-dir --save",
    usage: "/add-dir --save <path>",
    description: "Allow and save an extra directory",
    completion: "/add-dir --save "
  },
  {
    command: "/exit",
    usage: "/exit",
    description: "Quit",
    completion: "/exit"
  }
];

export function getReplCommandHelpLines(currentModel: string) {
  const usageWidth = REPL_COMMAND_DEFINITIONS.reduce(
    (width, command) => Math.max(width, command.usage.length),
    0
  );

  return REPL_COMMAND_DEFINITIONS.map((command) => {
    const suffix = command.command === "/model" ? ` (current: ${currentModel})` : "";
    return `  ${command.usage.padEnd(usageWidth)}  ${command.description}${suffix}`;
  });
}

// Normalized result for built-in REPL commands.
export type ParsedCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "doctor" }
  | { type: "plan-enter" }
  | { type: "plan-exit" }
  | { type: "clear" }
  | { type: "rewind" }
  | { type: "exit" }
  | { type: "open-settings"; section: "connection" | "session" }
  | { type: "open-permissions" }
  | { type: "connect-provider"; provider?: string; args: string[] }
  | { type: "logout-provider"; provider: string }
  | { type: "open-session-picker" }
  | { type: "resume-session"; query: string }
  | { type: "sessions-list" }
  | { type: "command-error"; input: string; message: string }
  | { type: "remember"; note: string; persist: boolean }
  | { type: "memory-view" }
  | { type: "memory-clear"; clearPersistent: boolean }
  | { type: "add-directory"; directory: string; persist: boolean }
  | { type: "open-model-picker" }
  | { type: "model-view" }
  | { type: "switch-model"; model: string }
  | { type: "tasks-list" }
  | { type: "tasks-get"; taskId: string }
  | { type: "tasks-stop"; taskId: string }
  | { type: "tasks-cleanup"; apply: boolean }
  | { type: "processes-list" }
  | { type: "process-stop"; processId: string }
  | { type: "usage-view" }
  | { type: "diff-view"; target: "overview" | "last" | "current" | { turnId: string } }
  | { type: "revert"; mode: "prompt" | "files-only" | "conversation-only" }
  | { type: "context-preview"; nextUserInput?: string };

// Parse REPL commands in one place so the main loop stays simple.
export function parseReplCommand(input: string): ParsedCommand {
  if (input === "/") {
    return {
      type: "command-error",
      input,
      message: "Please enter a complete command."
    };
  }

  // Exact commands go first to avoid conflicts with prefix commands.
  if (input === "/help") {
    return { type: "help" };
  }

  if (input === "/doctor") {
    return { type: "doctor" };
  }

  if (input === "/plan") {
    return { type: "plan-enter" };
  }

  if (input === "/build" || input === "/plan exit") {
    return { type: "plan-exit" };
  }

  if (input.startsWith("/build ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported /build argument. In Alyce, /build only exits Plan Mode; run build commands as normal prompts or approved shell commands."
    };
  }

  if (input.startsWith("/plan ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported /plan argument. Use /plan to enter Plan Mode, then /plan exit or /build to leave it."
    };
  }

  if (input === "/clear") {
    return { type: "clear" };
  }

  if (input === "/rewind") {
    return { type: "rewind" };
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

  if (input === "/exit") {
    return { type: "exit" };
  }

  if (input === "/settings") {
    return { type: "open-settings", section: "session" };
  }

  if (input === "/permissions") {
    return { type: "open-permissions" };
  }

  if (input.startsWith("/permissions ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported /permissions argument. Use /permissions."
    };
  }

  if (input === "/setup") {
    return { type: "connect-provider", args: [] };
  }

  if (input === "/connect") {
    return { type: "connect-provider", args: [] };
  }

  if (input.startsWith("/connect ")) {
    const tokens = input.slice(9).trim().split(/\s+/).filter(Boolean);
    return {
      type: "connect-provider",
      provider: tokens[0],
      args: tokens.slice(1)
    };
  }

  if (input === "/logout") {
    return {
      type: "command-error",
      input,
      message: "Missing provider. Use /logout <provider>."
    };
  }

  if (input.startsWith("/logout ")) {
    const provider = input.slice(8).trim();
    if (!provider || provider.includes(" ")) {
      return {
        type: "command-error",
        input,
        message: "Use /logout <provider> with one provider id."
      };
    }

    return {
      type: "logout-provider",
      provider
    };
  }

  const memoryCommand = parseMemoryCommand(input);
  if (memoryCommand) {
    return memoryCommand;
  }

  const tasksCommand = parseTasksCommand(input);
  if (tasksCommand) {
    return tasksCommand;
  }

  const processCommand = parseProcessCommand(input);
  if (processCommand) {
    return processCommand;
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

  if (input === "/add-dir") {
    return {
      type: "command-error",
      input,
      message: "Missing directory path."
    };
  }

  if (input.startsWith("/add-dir ")) {
    const raw = input.slice(9).trim();
    if (!raw) {
      return {
        type: "command-error",
        input,
        message: "Missing directory path."
      };
    }

    if (raw.startsWith("--save ")) {
      const directory = raw.slice(7).trim();
      if (!directory) {
        return {
          type: "command-error",
          input,
          message: "Missing directory path to save."
        };
      }

      return {
        type: "add-directory",
        directory,
        persist: true
      };
    }

    return {
      type: "add-directory",
      directory: raw,
      persist: false
    };
  }

  if (input === "/model") {
    return { type: "open-model-picker" };
  }

  if (input === "/model list" || input === "/models") {
    return { type: "model-view" };
  }

  if (input.startsWith("/model ")) {
    // /model only takes effect when a non-empty model name is provided.
    const model = input.slice(7).trim();
    if (model) {
      return {
        type: "switch-model",
        model
      };
    }
  }

  if (input.startsWith("/")) {
    return {
      type: "command-error",
      input,
      message: "Unknown command. Enter /help to view available commands."
    };
  }

  return { type: "none" };
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
      type: "revert",
      mode: "prompt"
    };
  }

  if (tokens.length === 2 && tokens[1] === "--files-only") {
    return {
      type: "revert",
      mode: "files-only"
    };
  }

  if (tokens.length === 2 && tokens[1] === "--conversation-only") {
    return {
      type: "revert",
      mode: "conversation-only"
    };
  }

  return {
    type: "command-error",
    input,
    message: "Unsupported /revert argument. Use /revert, /revert --files-only, or /revert --conversation-only."
  };
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

function parseTasksCommand(
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

  if (tokens[1] === "get" || tokens[1] === "log") {
    if (tokens.length !== 3) {
      return {
        type: "command-error",
        input,
        message: `Missing task id. Use /tasks ${tokens[1]} <id>.`
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

function parseProcessCommand(
  input: string
): Extract<ParsedCommand, { type: "processes-list" | "process-stop" | "command-error" }> | null {
  if (input === "/processes" || input === "/bg") {
    return {
      type: "processes-list"
    };
  }

  if (input.startsWith("/processes ") || input.startsWith("/bg ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported background process list argument. Use /processes or /bg."
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
