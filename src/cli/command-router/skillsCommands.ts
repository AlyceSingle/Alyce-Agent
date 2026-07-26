import type { ParsedCommand } from "./types.js";
import { createMigrationCommandError } from "./types.js";

// Skills commands: /skills subcommands.
export function parseSkillsCommand(
  input: string
): Extract<
  ParsedCommand,
  {
    type:
      | "skills-list"
      | "skills-view"
      | "skills-set-enabled"
      | "skills-refresh"
      | "command-error";
  }
> | null {
  if (input !== "/skills" && !input.startsWith("/skills ")) {
    return null;
  }

  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return { type: "skills-list" };
  }

  if (tokens.length === 2 && tokens[1] === "list") {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /skills."
    );
  }

  if (tokens.length === 2 && tokens[1] === "refresh") {
    return { type: "skills-refresh" };
  }

  if (tokens.length === 2 && tokens[1] === "show") {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /skills <name>."
    );
  }

  if (tokens.length === 2) {
    return {
      type: "skills-view",
      name: tokens[1]!
    };
  }

  if (tokens.length === 3 && tokens[1] === "show") {
    return createMigrationCommandError(
      input,
      `This command was removed. Use /skills ${tokens[2]!}.`
    );
  }

  const toggleCommand = parseSkillsToggleCommand(input, tokens);
  if (toggleCommand) {
    return toggleCommand;
  }

  return {
    type: "command-error",
    input,
    message: "Unsupported /skills argument. Use /skills, /skills <name>, /skills enable <name>, /skills disable <name>, or /skills refresh."
  };
}

function parseSkillsToggleCommand(
  input: string,
  tokens: string[]
): Extract<ParsedCommand, { type: "skills-set-enabled" | "command-error" }> | null {
  const action = tokens[1];
  if (action !== "enable" && action !== "disable") {
    return null;
  }

  const enabled = action === "enable";
  let target: "project" | "user" = "project";
  const args = tokens.slice(2);

  if (args[0] === "--user") {
    target = "user";
    args.shift();
  } else if (args[0] === "--project") {
    target = "project";
    args.shift();
  }

  if (args.length === 1 && args[0] === "--bundled") {
    return {
      type: "skills-set-enabled",
      enabled,
      target,
      reference: { kind: "bundled" }
    };
  }

  if (args.length === 2 && args[0] === "--id") {
    return {
      type: "skills-set-enabled",
      enabled,
      target,
      reference: { kind: "id", value: args[1]! }
    };
  }

  if (args.length >= 2 && args[0] === "--path") {
    return {
      type: "skills-set-enabled",
      enabled,
      target,
      reference: { kind: "path", value: args.slice(1).join(" ") }
    };
  }

  if (args.length === 1) {
    return {
      type: "skills-set-enabled",
      enabled,
      target,
      reference: { kind: "name", value: args[0]! }
    };
  }

  return {
    type: "command-error",
    input,
    message: "Unsupported /skills toggle argument. Use /skills enable|disable <name>, --id <id>, --path <path>, or --bundled, optionally with --user."
  };
}
