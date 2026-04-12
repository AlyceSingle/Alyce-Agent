// REPL 内置命令的标准化结果。
export type ParsedCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "remember"; note: string; persist: boolean }
  | { type: "memory-view" }
  | { type: "memory-clear"; clearPersistent: boolean }
  | { type: "switch-model"; model: string }
  | { type: "context-preview"; nextUserInput?: string };

// 统一解析 REPL 命令，避免在主循环堆积条件分支。
export function parseReplCommand(input: string): ParsedCommand {
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

  if (input === "/memory") {
    return { type: "memory-view" };
  }

  if (input === "/memory clear") {
    return {
      type: "memory-clear",
      clearPersistent: false
    };
  }

  if (input === "/memory clear --all") {
    return {
      type: "memory-clear",
      clearPersistent: true
    };
  }

  if (input.startsWith("/remember ")) {
    const raw = input.slice(10).trim();
    if (!raw) {
      return { type: "none" };
    }

    // /remember --session xxx 只写入会话内存，不落盘。
    if (raw.startsWith("--session ")) {
      const note = raw.slice(10).trim();
      if (!note) {
        return { type: "none" };
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

  return { type: "none" };
}
