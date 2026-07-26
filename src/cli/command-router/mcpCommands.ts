import type { McpConfigScope } from "../../mcp/types.js";
import type { ParsedCommand } from "./types.js";
import { createMigrationCommandError } from "./types.js";

// MCP commands: /mcp subcommands.
export function parseMcpCommand(
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
