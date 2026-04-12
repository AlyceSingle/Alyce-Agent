export type ParsedCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "switch-model"; model: string }
  | { type: "context-preview"; nextUserInput?: string };

// 统一解析 REPL 命令，避免在主循环堆积条件分支。
export function parseReplCommand(input: string): ParsedCommand {
  if (input === "/help") {
    return { type: "help" };
  }

  if (input === "/clear") {
    return { type: "clear" };
  }

  if (input === "/exit") {
    return { type: "exit" };
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
