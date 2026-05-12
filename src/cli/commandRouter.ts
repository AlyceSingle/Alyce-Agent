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
    command: "/settings",
    usage: "/settings",
    description: "Open runtime settings",
    completion: "/settings"
  },
  {
    command: "/setup",
    usage: "/setup",
    description: "Open connection setup",
    completion: "/setup"
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
    command: "/context",
    usage: "/context [text]",
    description: "Show full next-turn AI context payload",
    completion: "/context"
  },
  {
    command: "/model",
    usage: "/model <name>",
    description: "Switch model and persist it",
    completion: "/model "
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

// REPL 内置命令的标准化结果。
export type ParsedCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "clear" }
  | { type: "rewind" }
  | { type: "exit" }
  | { type: "open-settings"; section: "connection" | "session" }
  | { type: "open-session-picker" }
  | { type: "resume-session"; query: string }
  | { type: "sessions-list" }
  | { type: "command-error"; input: string; message: string }
  | { type: "remember"; note: string; persist: boolean }
  | { type: "memory-view" }
  | { type: "memory-clear"; clearPersistent: boolean }
  | { type: "add-directory"; directory: string; persist: boolean }
  | { type: "switch-model"; model: string }
  | { type: "tasks-cleanup"; apply: boolean }
  | { type: "context-preview"; nextUserInput?: string };

// 统一解析 REPL 命令，避免在主循环堆积条件分支。
export function parseReplCommand(input: string): ParsedCommand {
  if (input === "/") {
    return {
      type: "command-error",
      input,
      message: "请输入完整命令。"
    };
  }

  // 精确命令优先，避免与前缀命令冲突。
  if (input === "/help") {
    return { type: "help" };
  }

  if (input === "/clear") {
    return { type: "clear" };
  }

  if (input === "/rewind") {
    return { type: "rewind" };
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
        message: "缺少要恢复的会话 ID 或搜索词。"
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

  if (input === "/setup") {
    return { type: "open-settings", section: "connection" };
  }

  const memoryCommand = parseMemoryCommand(input);
  if (memoryCommand) {
    return memoryCommand;
  }

  const tasksCommand = parseTasksCommand(input);
  if (tasksCommand) {
    return tasksCommand;
  }

  if (input === "/remember") {
    return {
      type: "command-error",
      input,
      message: "缺少记忆内容。"
    };
  }

  if (input.startsWith("/remember ")) {
    const raw = input.slice(10).trim();
    if (!raw) {
      return {
        type: "command-error",
        input,
        message: "缺少记忆内容。"
      };
    }

    // /remember --session xxx 只写入会话内存，不落盘。
    if (raw.startsWith("--session ")) {
      const note = raw.slice(10).trim();
      if (!note) {
        return {
          type: "command-error",
          input,
          message: "缺少会话记忆内容。"
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
      message: "缺少目录路径。"
    };
  }

  if (input.startsWith("/add-dir ")) {
    const raw = input.slice(9).trim();
    if (!raw) {
      return {
        type: "command-error",
        input,
        message: "缺少目录路径。"
      };
    }

    if (raw.startsWith("--save ")) {
      const directory = raw.slice(7).trim();
      if (!directory) {
        return {
          type: "command-error",
          input,
          message: "缺少要持久化的目录路径。"
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

  if (input.startsWith("/model ")) {
    // /model 仅在给出非空模型名时生效。
    const model = input.slice(7).trim();
    if (model) {
      return {
        type: "switch-model",
        model
      };
    }
  }

  if (input === "/model") {
    return {
      type: "command-error",
      input,
      message: "缺少模型名。"
    };
  }

  if (input.startsWith("/")) {
    return {
      type: "command-error",
      input,
      message: "未知命令。输入 /help 查看可用命令。"
    };
  }

  return { type: "none" };
}

function parseMemoryCommand(
  input: string
): Extract<ParsedCommand, { type: "memory-view" | "memory-clear" | "command-error" }> | null {
  if (!input.startsWith("/memory")) {
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
      message: "不支持的 /memory 子命令。"
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
    message: "不支持的 /memory clear 参数。"
  };
}

function parseTasksCommand(
  input: string
): Extract<ParsedCommand, { type: "tasks-cleanup" | "command-error" }> | null {
  if (input !== "/tasks" && !input.startsWith("/tasks ")) {
    return null;
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return {
      type: "command-error",
      input,
      message: "缺少 /tasks 子命令。"
    };
  }

  if (tokens[1] !== "cleanup") {
    return {
      type: "command-error",
      input,
      message: "不支持的 /tasks 子命令。"
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
    message: "不支持的 /tasks cleanup 参数。"
  };
}
