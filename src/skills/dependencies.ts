import { normalizeMcpServerName } from "../mcp/config.js";
import type { McpToolRuntime } from "../mcp/types.js";
import type { SkillDependency, SkillDescriptor } from "./types.js";

export interface SkillDependencyNotice {
  skillName: string;
  dependency: SkillDependency;
  status: "missing" | "disabled" | "unverified";
  message: string;
}

export async function collectSkillDependencyNotices(
  skills: SkillDescriptor[],
  mcpRuntime: McpToolRuntime | undefined,
  options: {
    abortSignal?: AbortSignal;
  } = {}
): Promise<SkillDependencyNotice[]> {
  const mcpDependencies = skills.some((skill) =>
    skill.dependencies.some((dependency) =>
      dependency.type === "mcp_server" || dependency.type === "mcp_tool"
    )
  );
  if (!mcpDependencies) {
    return [];
  }

  if (!mcpRuntime) {
    return skills.flatMap((skill) =>
      skill.dependencies
        .filter((dependency) => dependency.type === "mcp_server" || dependency.type === "mcp_tool")
        .map((dependency) => ({
          skillName: skill.name,
          dependency,
          status: "unverified" as const,
          message: `Skill '${skill.name}' declares MCP dependency '${dependency.name}', but MCP runtime is not available in this execution context.`
        }))
    );
  }

  const status = await mcpRuntime.getStatus({
    abortSignal: options.abortSignal,
    initialize: false
  });
  const serverByName = new Map(
    status.servers.map((server) => [normalizeMcpServerName(server.name), server] as const)
  );
  const connectedToolNames = new Map<string, Set<string>>();
  const notices: SkillDependencyNotice[] = [];

  for (const skill of skills) {
    for (const dependency of skill.dependencies) {
      if (dependency.type === "generic") {
        continue;
      }

      if (dependency.type === "mcp_server") {
        const serverName = normalizeMcpServerName(dependency.name);
        const server = serverByName.get(serverName);
        if (!server) {
          notices.push({
            skillName: skill.name,
            dependency,
            status: "missing",
            message: `Skill '${skill.name}' requires MCP server '${dependency.name}', but it is not configured.`
          });
          continue;
        }

        if (!server.enabled || server.status === "disabled") {
          notices.push({
            skillName: skill.name,
            dependency,
            status: "disabled",
            message: `Skill '${skill.name}' requires MCP server '${server.name}', but it is currently disabled.`
          });
        }
        continue;
      }

      const parsedToolDependency = parseMcpToolDependency(dependency.name);
      if (!parsedToolDependency) {
        notices.push({
          skillName: skill.name,
          dependency,
          status: "unverified",
          message: `Skill '${skill.name}' declares MCP tool dependency '${dependency.name}', but it does not include a server qualifier like server.tool.`
        });
        continue;
      }

      const server = serverByName.get(parsedToolDependency.serverName);
      if (!server) {
        notices.push({
          skillName: skill.name,
          dependency,
          status: "missing",
          message: `Skill '${skill.name}' requires MCP server '${parsedToolDependency.serverName}', but it is not configured.`
        });
        continue;
      }

      if (!server.enabled || server.status === "disabled") {
        notices.push({
          skillName: skill.name,
          dependency,
          status: "disabled",
          message: `Skill '${skill.name}' requires MCP tool '${dependency.name}', but server '${server.name}' is disabled.`
        });
        continue;
      }

      if (server.status !== "connected") {
        notices.push({
          skillName: skill.name,
          dependency,
          status: "unverified",
          message: `Skill '${skill.name}' requires MCP tool '${dependency.name}', but server '${server.name}' has not been initialized yet. Initialize MCP before relying on this tool.`
        });
        continue;
      }

      let toolNames = connectedToolNames.get(server.name);
      if (!toolNames) {
        const listed = await mcpRuntime.listTools({
          serverName: server.name,
          abortSignal: options.abortSignal
        });
        const listedServer = listed.servers[0];
        if (!listedServer || listedServer.status !== "completed") {
          notices.push({
            skillName: skill.name,
            dependency,
            status: "unverified",
            message: `Skill '${skill.name}' requires MCP tool '${dependency.name}', but Alyce could not verify tools on server '${server.name}'. ${listedServer?.error ?? ""}`.trim()
          });
          continue;
        }

        toolNames = new Set(listedServer.tools.map((tool) => tool.name.toLowerCase()));
        connectedToolNames.set(server.name, toolNames);
      }

      if (!toolNames.has(parsedToolDependency.toolName.toLowerCase())) {
        notices.push({
          skillName: skill.name,
          dependency,
          status: "missing",
          message: `Skill '${skill.name}' requires MCP tool '${dependency.name}', but server '${server.name}' does not expose '${parsedToolDependency.toolName}'.`
        });
      }
    }
  }

  return dedupeSkillDependencyNotices(notices);
}

export function formatSkillDependencyNotices(
  notices: SkillDependencyNotice[]
): string[] {
  return notices.map((notice) => notice.message);
}

function parseMcpToolDependency(value: string): {
  serverName: string;
  toolName: string;
} | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  for (const separator of ["::", "/", ":", "."]) {
    const index = trimmed.indexOf(separator);
    if (index <= 0 || index >= trimmed.length - separator.length) {
      continue;
    }

    const serverName = normalizeMcpServerName(trimmed.slice(0, index));
    const toolName = trimmed.slice(index + separator.length).trim();
    if (!serverName || !toolName) {
      return null;
    }

    return {
      serverName,
      toolName
    };
  }

  return null;
}

function dedupeSkillDependencyNotices(notices: SkillDependencyNotice[]) {
  const selected = new Map<string, SkillDependencyNotice>();
  for (const notice of notices) {
    const key = [
      notice.skillName.toLowerCase(),
      notice.dependency.type,
      notice.dependency.name.toLowerCase(),
      notice.status
    ].join("\0");
    if (!selected.has(key)) {
      selected.set(key, notice);
    }
  }

  return [...selected.values()];
}
