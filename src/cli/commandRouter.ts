// REPL 内置命令的标准化结果。
export type ParsedCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "open-settings"; section: "connection" | "session" }
  | { type: "command-error"; input: string; message: string }
  | { type: "remember"; note: string; persist: boolean }
  | { type: "memory-view" }
  | { type: "memory-clear"; clearPersistent: boolean }
  | { type: "add-directory"; directory: string; persist: boolean }
  | { type: "switch-model"; model: string }
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
