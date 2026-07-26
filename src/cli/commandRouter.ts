import type { ParsedCommand } from "./command-router/types.js";
import { parseConnectionCommand } from "./command-router/connectionCommands.js";
import { parseCoreCommand } from "./command-router/coreCommands.js";
import { parseMcpCommand } from "./command-router/mcpCommands.js";
import { parseSessionCommand } from "./command-router/sessionCommands.js";
import { parseSkillsCommand } from "./command-router/skillsCommands.js";
import { parseProcessCommand, parseTasksCommand } from "./command-router/taskCommands.js";
import { parseTrustCommand } from "./command-router/trustCommands.js";

// Facade: keep every historical export importable from this module.
export type { ReplCommandDefinition } from "./command-router/definitions.js";
export {
  REPL_COMMAND_DEFINITIONS,
  getReplCommandHelpLines
} from "./command-router/definitions.js";
export type { ParsedCommand } from "./command-router/types.js";

// Parse REPL commands in one place so the main loop stays simple.
// Each command family lives in ./command-router/; the families match on
// disjoint command prefixes, so dispatch order does not change results.
export function parseReplCommand(input: string): ParsedCommand {
  if (input === "/") {
    return {
      type: "command-error",
      input,
      message: "Please enter a complete command."
    };
  }

  const coreCommand = parseCoreCommand(input);
  if (coreCommand) {
    return coreCommand;
  }

  const sessionCommand = parseSessionCommand(input);
  if (sessionCommand) {
    return sessionCommand;
  }

  const trustCommand = parseTrustCommand(input);
  if (trustCommand) {
    return trustCommand;
  }

  const connectionCommand = parseConnectionCommand(input);
  if (connectionCommand) {
    return connectionCommand;
  }

  const tasksCommand = parseTasksCommand(input);
  if (tasksCommand) {
    return tasksCommand;
  }

  const processCommand = parseProcessCommand(input);
  if (processCommand) {
    return processCommand;
  }

  const skillsCommand = parseSkillsCommand(input);
  if (skillsCommand) {
    return skillsCommand;
  }

  const mcpCommand = parseMcpCommand(input);
  if (mcpCommand) {
    return mcpCommand;
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
