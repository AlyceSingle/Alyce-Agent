import type { ParsedCommand } from "./types.js";

// Trust commands: /trust and /untrust.
export function parseTrustCommand(input: string): ParsedCommand | null {
  if (input === "/trust status") {
    return { type: "trust-status" };
  }

  if (input === "/trust" || input === "/trust enable" || input === "/trust project") {
    return {
      type: "project-trust-set",
      trusted: true
    };
  }

  if (input.startsWith("/trust ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported /trust argument. Use /trust or /trust status."
    };
  }

  if (input === "/untrust") {
    return {
      type: "project-trust-set",
      trusted: false
    };
  }

  if (input.startsWith("/untrust ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported /untrust argument. Use /untrust."
    };
  }

  return null;
}
