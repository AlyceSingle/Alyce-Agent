import type { McpConfigScope, McpServerConfig } from "../mcp/types.js";
import { t } from "../i18n/index.js";

export type ReplCommandDefinition = {
  command: string;
  usage: string;
  descriptionKey: string;
  completion: string;
  searchPrefixes?: string[];
  group: "Core" | "Session" | "Connection" | "Trust" | "Tasks" | "Skills & MCP";
};

export const REPL_COMMAND_DEFINITIONS: ReplCommandDefinition[] = [
  {
    command: "/help",
    usage: "/help",
    descriptionKey: "command.help.description",
    completion: "/help",
    group: "Core"
  },
  {
    command: "/doctor",
    usage: "/doctor",
    descriptionKey: "command.doctor.description",
    completion: "/doctor",
    group: "Core"
  },
  {
    command: "/plan",
    usage: "/plan",
    descriptionKey: "command.plan.description",
    completion: "/plan",
    group: "Core"
  },
  {
    command: "/build",
    usage: "/build",
    descriptionKey: "command.planExit.description",
    completion: "/build",
    group: "Core"
  },
  {
    command: "/settings",
    usage: "/settings [session|connection]",
    descriptionKey: "command.settings.description",
    completion: "/settings",
    group: "Connection"
  },
  {
    command: "/permissions",
    usage: "/permissions",
    descriptionKey: "command.permissions.description",
    completion: "/permissions",
    group: "Connection"
  },
  {
    command: "/trust",
    usage: "/trust [status]",
    descriptionKey: "command.trust.description",
    completion: "/trust",
    searchPrefixes: ["/trust status"],
    group: "Trust"
  },
  {
    command: "/untrust",
    usage: "/untrust",
    descriptionKey: "command.untrust.description",
    completion: "/untrust",
    group: "Trust"
  },
  {
    command: "/connect",
    usage: "/connect [provider ...]",
    descriptionKey: "command.connect.description",
    completion: "/connect",
    searchPrefixes: ["/connect "],
    group: "Connection"
  },
  {
    command: "/logout",
    usage: "/logout <provider>",
    descriptionKey: "command.logout.description",
    completion: "/logout",
    searchPrefixes: ["/logout "],
    group: "Connection"
  },
  {
    command: "/clear",
    usage: "/clear",
    descriptionKey: "command.clear.description",
    completion: "/clear",
    group: "Core"
  },
  {
    command: "/revert",
    usage: "/revert",
    descriptionKey: "command.revert.description",
    completion: "/revert",
    group: "Session"
  },
  {
    command: "/diff",
    usage: "/diff",
    descriptionKey: "command.diff.description",
    completion: "/diff",
    group: "Session"
  },
  {
    command: "/resume",
    usage: "/resume [id|text]",
    descriptionKey: "command.resume.description",
    completion: "/resume",
    searchPrefixes: ["/resume "],
    group: "Session"
  },
  {
    command: "/sessions",
    usage: "/sessions",
    descriptionKey: "command.sessions.description",
    completion: "/sessions",
    group: "Session"
  },
  {
    command: "/remember",
    usage: "/remember [--session] <text>",
    descriptionKey: "command.memory.description",
    completion: "/remember",
    searchPrefixes: ["/remember ", "/remember --session"],
    group: "Session"
  },
  {
    command: "/memory",
    usage: "/memory [clear [--all]]",
    descriptionKey: "command.memories.description",
    completion: "/memory",
    searchPrefixes: ["/memory clear", "/memory clear --all"],
    group: "Session"
  },
  {
    command: "/tasks",
    usage: "/tasks [get|stop <id> | cleanup [--apply]]",
    descriptionKey: "command.tasks.description",
    completion: "/tasks",
    searchPrefixes: [
      "/tasks get",
      "/tasks stop",
      "/tasks cleanup",
      "/tasks cleanup --apply"
    ],
    group: "Tasks"
  },
  {
    command: "/processes",
    usage: "/processes",
    descriptionKey: "command.bg.description",
    completion: "/processes",
    group: "Tasks"
  },
  {
    command: "/stop",
    usage: "/stop <id>",
    descriptionKey: "command.bgstop.description",
    completion: "/stop",
    searchPrefixes: ["/stop "],
    group: "Tasks"
  },
  {
    command: "/usage",
    usage: "/usage",
    descriptionKey: "command.usage.description",
    completion: "/usage",
    group: "Session"
  },
  {
    command: "/context",
    usage: "/context [text]",
    descriptionKey: "command.context.description",
    completion: "/context",
    searchPrefixes: ["/context "],
    group: "Session"
  },
  {
    command: "/skills",
    usage: "/skills [<name> | enable|disable ... | refresh]",
    descriptionKey: "command.skills.description",
    completion: "/skills",
    searchPrefixes: ["/skills ", "/skills enable", "/skills disable", "/skills refresh"],
    group: "Skills & MCP"
  },
  {
    command: "/mcp",
    usage: "/mcp <status|tools|resources|prompts|prompt|templates|login|add|remove|enable|disable> ...",
    descriptionKey: "command.mcp.description",
    completion: "/mcp",
    searchPrefixes: [
      "/mcp ",
      "/mcp status",
      "/mcp tools",
      "/mcp resources",
      "/mcp prompts",
      "/mcp prompt",
      "/mcp templates",
      "/mcp login",
      "/mcp add",
      "/mcp remove",
      "/mcp enable",
      "/mcp disable"
    ],
    group: "Skills & MCP"
  },
  {
    command: "/model",
    usage: "/model [provider/model]",
    descriptionKey: "command.model.description",
    completion: "/model",
    group: "Connection"
  },
  {
    command: "/add-dir",
    usage: "/add-dir [--save] <path>",
    descriptionKey: "command.allowDir.description",
    completion: "/add-dir",
    searchPrefixes: ["/add-dir ", "/add-dir --save"],
    group: "Connection"
  },
  {
    command: "/exit",
    usage: "/exit",
    descriptionKey: "command.quit.description",
    completion: "/exit",
    group: "Core"
  }
];

export function getReplCommandHelpLines(currentModel: string) {
  const usageWidth = REPL_COMMAND_DEFINITIONS.reduce(
    (width, command) => Math.max(width, command.usage.length),
    0
  );
  const lines: string[] = [];
  const groups: ReplCommandDefinition["group"][] = [
    "Core",
    "Session",
    "Connection",
    "Trust",
    "Tasks",
    "Skills & MCP"
  ];
  const groupLabels: Record<ReplCommandDefinition["group"], string> = {
    "Core": t("command.group.core"),
    "Session": t("command.group.session"),
    "Connection": t("command.group.connection"),
    "Trust": t("command.group.trust"),
    "Tasks": t("command.group.tasks"),
    "Skills & MCP": t("command.group.skillsMcp")
  };

  for (const group of groups) {
    const commands = REPL_COMMAND_DEFINITIONS.filter((command) => command.group === group);
    if (commands.length === 0) {
      continue;
    }

    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`${groupLabels[group]}:`);
    lines.push(...commands.map((command) => {
      const suffix = command.command === "/model" ? ` (current: ${currentModel})` : "";
      return `  ${command.usage.padEnd(usageWidth)}  ${t(command.descriptionKey)}${suffix}`;
    }));
  }

  return lines;
}

// Normalized result for built-in REPL commands.
export type ParsedCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "doctor" }
  | { type: "plan-enter" }
  | { type: "plan-exit" }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "open-settings"; section: "connection" | "session" }
  | { type: "open-permissions" }
  | { type: "trust-status" }
  | { type: "project-trust-set"; trusted: boolean }
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
  | { type: "skills-list" }
  | { type: "skills-view"; name: string }
  | {
      type: "skills-set-enabled";
      enabled: boolean;
      target: "project" | "user";
      reference:
        | { kind: "name"; value: string }
        | { kind: "id"; value: string }
        | { kind: "path"; value: string }
        | { kind: "bundled" };
    }
  | { type: "skills-refresh" }
  | { type: "mcp-list" }
  | { type: "mcp-status" }
  | { type: "mcp-tools"; serverName?: string }
  | { type: "mcp-resources"; serverName?: string }
  | { type: "mcp-prompts"; serverName?: string }
  | { type: "mcp-prompt"; serverName: string; promptName: string; args: Record<string, string> }
  | { type: "mcp-templates"; serverName?: string }
  | { type: "mcp-login"; serverName: string }
  | { type: "mcp-add"; scope: McpConfigScope; name: string; config: McpServerConfig }
  | { type: "mcp-remove"; scope: McpConfigScope; name: string }
  | { type: "mcp-set-enabled"; enabled: boolean; scope: McpConfigScope; name: string }
  | { type: "open-model-picker" }
  | { type: "switch-model"; model: string }
  | { type: "tasks-list" }
  | { type: "tasks-get"; taskId: string }
  | { type: "tasks-stop"; taskId: string }
  | { type: "tasks-cleanup"; apply: boolean }
  | { type: "processes-list" }
  | { type: "process-stop"; processId: string }
  | { type: "usage-view" }
  | { type: "diff-view"; target: "overview" | "last" | "current" | { turnId: string } }
  | { type: "revert" }
  | { type: "context-preview"; nextUserInput?: string };

function createMigrationCommandError(input: string, message: string): Extract<ParsedCommand, { type: "command-error" }> {
  return {
    type: "command-error",
    input,
    message
  };
}

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

  if (input === "/rewind" || input.startsWith("/rewind ")) {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /revert to open revert history."
    );
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

  const skillsCommand = parseSkillsCommand(input);
  if (skillsCommand) {
    return skillsCommand;
  }

  const mcpCommand = parseMcpCommand(input);
  if (mcpCommand) {
    return mcpCommand;
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
      type: "revert"
    };
  }

  return createMigrationCommandError(
    input,
    "Revert flags were removed. Use /revert and choose an action from the revert history."
  );
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

function parseSkillsCommand(
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

  if (tokens[1] === "log") {
    return createMigrationCommandError(
      input,
      tokens.length === 3
        ? `This command was removed. Use /tasks get ${tokens[2]!}.`
        : "This command was removed. Use /tasks get <id>."
    );
  }

  if (tokens[1] === "get") {
    if (tokens.length !== 3) {
      return {
        type: "command-error",
        input,
        message: "Missing task id. Use /tasks get <id>."
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
  if (input === "/bg" || input.startsWith("/bg ")) {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /processes."
    );
  }

  if (input === "/processes") {
    return {
      type: "processes-list"
    };
  }

  if (input.startsWith("/processes ")) {
    return {
      type: "command-error",
      input,
      message: "Unsupported background process list argument. Use /processes."
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

function parseMcpCommand(
  input: string
): Extract<
  ParsedCommand,
  {
    type:
      | "mcp-list"
      | "mcp-status"
      | "mcp-tools"
      | "mcp-resources"
      | "mcp-prompts"
      | "mcp-prompt"
      | "mcp-templates"
      | "mcp-login"
      | "mcp-add"
      | "mcp-remove"
      | "mcp-set-enabled"
      | "command-error";
  }
> | null {
  if (input !== "/mcp" && !input.startsWith("/mcp ")) {
    return null;
  }

  const tokens = tokenizeReplArguments(input);
  if (tokens.length === 1) {
    return { type: "mcp-list" };
  }

  const subcommand = tokens[1];
  if (subcommand === "list") {
    return createMigrationCommandError(
      input,
      "This command was removed. Use /mcp."
    );
  }

  if (subcommand === "status") {
    if (tokens.length === 2) {
      return { type: "mcp-status" };
    }

    return {
      type: "command-error",
      input,
      message: "Unsupported /mcp status argument. Use /mcp status."
    };
  }

  if (
    subcommand === "tools" ||
    subcommand === "resources" ||
    subcommand === "prompts" ||
    subcommand === "templates"
  ) {
    if (tokens.length === 2) {
      return {
        type:
          subcommand === "tools"
            ? "mcp-tools"
            : subcommand === "resources"
              ? "mcp-resources"
              : subcommand === "prompts"
                ? "mcp-prompts"
                : "mcp-templates"
      };
    }

    if (tokens.length === 3) {
      return {
        type:
          subcommand === "tools"
            ? "mcp-tools"
            : subcommand === "resources"
              ? "mcp-resources"
              : subcommand === "prompts"
                ? "mcp-prompts"
                : "mcp-templates",
        serverName: tokens[2]
      };
    }

    return {
      type: "command-error",
      input,
      message: `Unsupported /mcp ${subcommand} argument. Use /mcp ${subcommand} [server].`
    };
  }

  if (subcommand === "prompt") {
    if (tokens.length < 4) {
      return {
        type: "command-error",
        input,
        message: "Unsupported /mcp prompt argument. Use /mcp prompt <server> <prompt> [key=value ...]."
      };
    }

    const serverName = tokens[2]!;
    const promptName = tokens[3]!;
    const args: Record<string, string> = {};
    for (const token of tokens.slice(4)) {
      const separatorIndex = token.indexOf("=");
      if (separatorIndex <= 0) {
        return {
          type: "command-error",
          input,
          message: "Unsupported /mcp prompt argument. Use key=value pairs after the prompt name."
        };
      }

      const key = token.slice(0, separatorIndex).trim();
      const value = token.slice(separatorIndex + 1);
      if (!key) {
        return {
          type: "command-error",
          input,
          message: "Unsupported /mcp prompt argument. Argument keys cannot be empty."
        };
      }

      args[key] = value;
    }

    return {
      type: "mcp-prompt",
      serverName,
      promptName,
      args
    };
  }

  if (subcommand === "login") {
    if (tokens.length !== 3) {
      return {
        type: "command-error",
        input,
        message: "Unsupported /mcp login argument. Use /mcp login <server>."
      };
    }

    return {
      type: "mcp-login",
      serverName: tokens[2]!
    };
  }

  if (subcommand === "add") {
    const scopeResult = parseMcpScope(tokens, 2);
    if (scopeResult.error) {
      return {
        type: "command-error",
        input,
        message: scopeResult.error
      };
    }

    const name = tokens[scopeResult.nextIndex];
    const transport = tokens[scopeResult.nextIndex + 1];
    const target = tokens[scopeResult.nextIndex + 2];
    if (!name || !transport || !target) {
      return {
        type: "command-error",
        input,
        message: "Unsupported /mcp add argument. Use /mcp add [--user|--project|--local] <name> stdio <command> [args...], http <url>, or sse <url>."
      };
    }

    if (transport === "stdio") {
      return {
        type: "mcp-add",
        scope: scopeResult.scope,
        name,
        config: {
          type: "stdio",
          command: target,
          ...(tokens.length > scopeResult.nextIndex + 3
            ? { args: tokens.slice(scopeResult.nextIndex + 3) }
            : {})
        }
      };
    }

    if (transport === "http" || transport === "streamable_http") {
      if (tokens.length !== scopeResult.nextIndex + 3) {
        return {
          type: "command-error",
          input,
          message: "Unsupported /mcp add http argument. Use /mcp add [--user|--project|--local] <name> http <url>."
        };
      }

      return {
        type: "mcp-add",
        scope: scopeResult.scope,
        name,
        config: {
          type: "streamable_http",
          url: target
        }
      };
    }

    if (transport === "sse") {
      if (tokens.length !== scopeResult.nextIndex + 3) {
        return {
          type: "command-error",
          input,
          message: "Unsupported /mcp add sse argument. Use /mcp add [--user|--project|--local] <name> sse <url>."
        };
      }

      return {
        type: "mcp-add",
        scope: scopeResult.scope,
        name,
        config: {
          type: "sse",
          url: target
        }
      };
    }

    return {
      type: "command-error",
      input,
      message: "Unsupported /mcp add transport. Use stdio, http, or sse."
    };
  }

  if (subcommand === "remove" || subcommand === "enable" || subcommand === "disable") {
    const scopeResult = parseMcpScope(tokens, 2);
    if (scopeResult.error) {
      return {
        type: "command-error",
        input,
        message: scopeResult.error
      };
    }

    if (tokens.length !== scopeResult.nextIndex + 1) {
      return {
        type: "command-error",
        input,
        message: `Unsupported /mcp ${subcommand} argument. Use /mcp ${subcommand} [--user|--project|--local] <name>.`
      };
    }

    const name = tokens[scopeResult.nextIndex]!;
    if (subcommand === "remove") {
      return {
        type: "mcp-remove",
        scope: scopeResult.scope,
        name
      };
    }

    return {
      type: "mcp-set-enabled",
      enabled: subcommand === "enable",
      scope: scopeResult.scope,
      name
    };
  }

  return {
    type: "command-error",
    input,
    message: "Unsupported /mcp argument. Use /mcp, /mcp status, /mcp add, /mcp remove, /mcp enable, /mcp disable, /mcp tools, /mcp resources, /mcp prompts, /mcp prompt, /mcp templates, or /mcp login."
  };
}

function parseMcpScope(
  tokens: string[],
  startIndex: number
): { scope: McpConfigScope; nextIndex: number; error?: string } {
  const token = tokens[startIndex];
  if (!token) {
    return { scope: "project", nextIndex: startIndex };
  }

  if (token === "--project") {
    return { scope: "project", nextIndex: startIndex + 1 };
  }

  if (token === "--user") {
    return { scope: "user", nextIndex: startIndex + 1 };
  }

  if (token === "--local") {
    return { scope: "local", nextIndex: startIndex + 1 };
  }

  if (token.startsWith("--")) {
    return {
      scope: "project",
      nextIndex: startIndex,
      error: "Unsupported /mcp scope flag. Use --project, --user, or --local immediately after the subcommand."
    };
  }

  return { scope: "project", nextIndex: startIndex };
}

function tokenizeReplArguments(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote) {
      if (character === "\\" && index + 1 < input.length) {
        const next = input[index + 1]!;
        if (next === quote || next === "\\") {
          current += next;
          index += 1;
          continue;
        }
      }

      if (character === quote) {
        quote = null;
        continue;
      }

      current += character;
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
