import type { ParsedCommand } from "./types.js";
import { createMigrationCommandError } from "./types.js";

// Connection commands: /settings, /permissions, /connect, /logout, /add-dir,
// and /model (plus removed-command migrations).
export function parseConnectionCommand(input: string): ParsedCommand | null {
  if (input === "/settings") {
    return { type: "open-settings", section: "session" };
  }

  if (input.startsWith("/settings ")) {
    const section = input.slice("/settings ".length).trim();
    if (section === "session" || section === "connection") {
      return { type: "open-settings", section };
    }

    return {
      type: "command-error",
      input,
      message: "Unsupported /settings argument. Use /settings, /settings session, or /settings connection."
    };
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

  if (input === "/setup" || input.startsWith("/setup ")) {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /connect to manage provider connections."
    );
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

  if (input === "/models" || input.startsWith("/models ")) {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /model to open the model picker."
    );
  }

  if (input === "/model") {
    return { type: "open-model-picker" };
  }

  if (input === "/model list" || input.startsWith("/model list ")) {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /model to open the model picker."
    );
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

  return null;
}
