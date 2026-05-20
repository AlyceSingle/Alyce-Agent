import type {
  McpConfigMutationResult,
  McpListPromptsResult,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpListToolsResult,
  McpLoginResult,
  McpPromptResult,
  McpServerStatus,
  McpStatusResult
} from "../mcp/types.js";

export interface McpCommandContext {
  projectConfigPath: string;
  projectConfigExists: boolean;
  localConfigPath: string;
  localConfigExists: boolean;
  userConfigPath: string;
  userConfigExists: boolean;
}

export function formatMcpServerList(
  status: McpStatusResult,
  context?: McpCommandContext
): string {
  if (status.servers.length === 0) {
    return formatNoMcpServers(
      "Configured MCP servers",
      "No MCP servers are configured yet.",
      context
    );
  }

  const lines = [
    "Configured MCP servers",
    `Count: ${status.servers.length}`,
    ""
  ];

  for (const server of status.servers) {
    lines.push(
      `- ${server.name} [${server.scope}] | ${server.transport} | ${server.enabled ? "enabled" : "disabled"} | status: ${server.status} | tools: ${server.toolCount} | direct: ${server.directToolCount} | hidden: ${server.hiddenToolCount}`,
      `  Endpoint: ${server.endpoint}`
    );
    if (server.recentError) {
      lines.push(`  Recent error: ${server.recentError}`);
    }
  }

  if (status.message) {
    lines.push("", status.message);
  }

  return lines.join("\n");
}

export function formatMcpStatus(
  status: McpStatusResult,
  context?: McpCommandContext
): string {
  if (status.servers.length === 0) {
    return formatNoMcpServers(
      "MCP status",
      "No MCP servers are configured yet.",
      context
    );
  }

  const lines = ["MCP status"];
  for (const server of status.servers) {
    lines.push("", ...formatServerStatus(server));
  }

  if (status.message) {
    lines.push("", status.message);
  }

  return lines.join("\n");
}

export function formatMcpTools(
  result: McpListToolsResult,
  context?: McpCommandContext
): string {
  if (result.servers.length === 0) {
    return formatNoMcpServers(
      "MCP tools",
      "No MCP servers are configured yet, so there are no MCP tools to list.",
      context
    );
  }

  const lines = [
    "MCP tools",
    `Total tools: ${result.toolCount}`
  ];

  for (const server of result.servers) {
    lines.push("", `Server ${server.server} (${server.status})`);
    if (server.error) {
      lines.push(server.error);
      continue;
    }

    if (server.tools.length === 0) {
      lines.push("(no tools)");
      continue;
    }

    for (const tool of server.tools) {
      const description = tool.description.trim() || "(no description)";
      lines.push(`- ${tool.name} -> ${tool.exposedName} | ${description}`);
    }
  }

  return lines.join("\n");
}

export function formatMcpResources(
  result: McpListResourcesResult,
  context?: McpCommandContext
): string {
  if (result.servers.length === 0) {
    return formatNoMcpServers(
      "MCP resources",
      "No MCP servers are configured yet, so there are no MCP resources to list.",
      context
    );
  }

  const lines = [
    "MCP resources",
    `Total resources: ${result.resourceCount}`
  ];

  for (const server of result.servers) {
    lines.push("", `Server ${server.server} (${server.status})`);
    if (server.error) {
      lines.push(server.error);
      continue;
    }

    if (server.resources.length === 0) {
      lines.push("(no resources)");
      continue;
    }

    for (const resource of server.resources) {
      const summary = formatMimeAndSizeDetails(resource.uri, resource.mimeType, resource.size);
      lines.push(`- ${resource.name}: ${summary}`);
    }
  }

  return lines.join("\n");
}

export function formatMcpPrompts(
  result: McpListPromptsResult,
  context?: McpCommandContext
): string {
  if (result.servers.length === 0) {
    return formatNoMcpServers(
      "MCP prompts",
      "No MCP servers are configured yet, so there are no MCP prompts to list.",
      context
    );
  }

  const lines = [
    "MCP prompts",
    `Total prompts: ${result.promptCount}`
  ];

  for (const server of result.servers) {
    lines.push("", `Server ${server.server} (${server.status})`);
    if (server.error) {
      lines.push(server.error);
      continue;
    }

    if (server.prompts.length === 0) {
      lines.push("(no prompts)");
      continue;
    }

    for (const prompt of server.prompts) {
      const argumentSummary = prompt.arguments.length > 0
        ? prompt.arguments.map((argument) => `${argument.name}${argument.required ? "*" : ""}`).join(", ")
        : "(no arguments)";
      lines.push(
        `- ${prompt.name}: ${prompt.description?.trim() || prompt.title || "(no description)"} | args: ${argumentSummary}`
      );
    }
  }

  return lines.join("\n");
}

export function formatMcpPrompt(result: McpPromptResult): string {
  const lines = [
    `MCP prompt ${result.server}/${result.name}`,
    `Status: ${result.status}`
  ];

  if (result.description) {
    lines.push(`Description: ${result.description}`);
  }
  if (result.error) {
    lines.push(`Error: ${result.error}`);
    return lines.join("\n");
  }

  if (result.messages.length === 0) {
    lines.push("(no messages)");
    return lines.join("\n");
  }

  for (const [index, message] of result.messages.entries()) {
    lines.push("", `Message ${index + 1} (${message.role})`);
    if (message.content.length === 0) {
      lines.push("(empty)");
      continue;
    }

    for (const content of message.content) {
      if (content.type === "text") {
        lines.push(`- text (${content.length} chars${content.truncated ? ", truncated" : ""})`);
        lines.push(content.text);
        continue;
      }

      if (content.type === "resource_text") {
        lines.push(`- resource ${content.uri} (${content.length} chars${content.truncated ? ", truncated" : ""})`);
        lines.push(content.text);
        continue;
      }

      if (content.type === "resource_link") {
        const details = formatMimeAndSizeDetails(content.uri, content.mimeType, content.size);
        lines.push(`- resource_link ${content.name}: ${details}`);
        continue;
      }

      lines.push(
        `- ${content.type} saved to ${content.outputPath} (${content.sizeBytes} bytes, mime=${content.mimeType})`
      );
    }
  }

  return lines.join("\n");
}

export function formatMcpResourceTemplates(
  result: McpListResourceTemplatesResult,
  context?: McpCommandContext
): string {
  if (result.servers.length === 0) {
    return formatNoMcpServers(
      "MCP resource templates",
      "No MCP servers are configured yet, so there are no MCP resource templates to list.",
      context
    );
  }

  const lines = [
    "MCP resource templates",
    `Total templates: ${result.resourceTemplateCount}`
  ];

  for (const server of result.servers) {
    lines.push("", `Server ${server.server} (${server.status})`);
    if (server.error) {
      lines.push(server.error);
      continue;
    }

    if (server.resourceTemplates.length === 0) {
      lines.push("(no templates)");
      continue;
    }

    for (const template of server.resourceTemplates) {
      const details = [
        template.uriTemplate,
        template.mimeType ? `mime=${template.mimeType}` : ""
      ].filter(Boolean).join(" | ");
      lines.push(`- ${template.name}: ${details}`);
    }
  }

  return lines.join("\n");
}

export function formatMcpLoginResult(result: McpLoginResult): string {
  const lines = [
    `MCP login ${result.server}`,
    `Status: ${result.status}`,
    result.message
  ];

  if (result.authorizationUrl) {
    lines.push(`Authorization URL: ${result.authorizationUrl}`);
  }
  if (result.redirectUrl) {
    lines.push(`Redirect URL: ${result.redirectUrl}`);
  }

  return lines.join("\n");
}

export function formatMcpMutation(
  action: "add" | "remove" | "enable" | "disable",
  result: McpConfigMutationResult
): string {
  const verb = action === "add"
    ? "Added"
    : action === "remove"
      ? "Removed"
      : action === "enable"
        ? "Enabled"
        : "Disabled";
  const suffix = result.changed ? "updated" : "unchanged";
  return [
    `${verb} MCP server '${result.serverName}' in ${result.scope} scope (${suffix}).`,
    `Config: ${result.configPath}`,
    `Effective servers: ${Object.keys(result.state.effective.mcpServers).length}`
  ].join("\n");
}

function formatNoMcpServers(
  title: string,
  summary: string,
  context?: McpCommandContext
): string {
  if (!context) {
    return `${title}\n${summary}`;
  }

  return [
    title,
    summary,
    "",
    "Config files:",
    ...formatMcpConfigLines(context),
    "",
    hasAnyMcpConfig(context)
      ? "Config files are present, but they currently define 0 effective servers."
      : "No MCP config files exist yet. Use /mcp add to create the first server entry."
  ].join("\n");
}

function formatMcpConfigLines(context: McpCommandContext) {
  return [
    `- Project: ${context.projectConfigPath} (${context.projectConfigExists ? "present" : "missing"})`,
    `- Local override: ${context.localConfigPath} (${context.localConfigExists ? "present" : "missing"})`,
    `- User: ${context.userConfigPath} (${context.userConfigExists ? "present" : "missing"})`
  ];
}

function hasAnyMcpConfig(context: McpCommandContext) {
  return context.projectConfigExists || context.localConfigExists || context.userConfigExists;
}

function formatServerStatus(server: McpServerStatus): string[] {
  const capabilities = [
    server.capabilities.tools ? "tools" : "",
    server.capabilities.resources ? "resources" : "",
    server.capabilities.prompts ? "prompts" : ""
  ].filter(Boolean);

  const lines = [
    `Server ${server.name}`,
    `Scope: ${server.scope}`,
    `Status: ${server.status}`,
    `Enabled: ${server.enabled ? "yes" : "no"}`,
    `Required: ${server.required ? "yes" : "no"}`,
    `Transport: ${server.transport}`,
    `Endpoint: ${server.endpoint}`,
    `Tools: ${server.toolCount}`,
    `Directly exposed tools: ${server.directToolCount}`,
    `Hidden by exposure budget: ${server.hiddenToolCount}`,
    `Exposure mode: ${server.toolExposure}`,
    `Capabilities: ${capabilities.length > 0 ? capabilities.join(", ") : "(none)"}`
  ];

  if (server.lastConnectedAt) {
    lines.push(`Last connected: ${server.lastConnectedAt}`);
  }
  if (server.lastOperation) {
    lines.push(`Last operation: ${server.lastOperation}`);
  }
  if (server.nextReconnectAt) {
    lines.push(`Next reconnect: ${server.nextReconnectAt}`);
  }
  if (server.error) {
    lines.push(`Error: ${server.error}`);
  } else if (server.recentError) {
    lines.push(`Recent error: ${server.recentError}`);
  }

  return lines;
}

function formatMimeAndSizeDetails(
  primaryValue: string,
  mimeType?: string,
  size?: number
) {
  return [
    primaryValue,
    mimeType ? `mime=${mimeType}` : "",
    size !== undefined ? `size=${size}` : ""
  ].filter(Boolean).join(" | ");
}
