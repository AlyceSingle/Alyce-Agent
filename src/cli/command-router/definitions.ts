import { t } from "../../i18n/index.js";

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
