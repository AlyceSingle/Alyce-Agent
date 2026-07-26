import type { ParsedCommand } from "./types.js";

// Core commands: /help, /doctor, /plan, /build, /clear, /exit.
export function parseCoreCommand(input: string): ParsedCommand | null {
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

  if (input === "/exit") {
    return { type: "exit" };
  }

  return null;
}
