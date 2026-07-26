import { promises as fs } from "node:fs";
import path from "node:path";
import { parseReplCommand } from "../../../cli/commandRouter.js";
import {
  formatMcpLoginResult,
  formatMcpPrompt,
  formatMcpPrompts,
  formatMcpMutation,
  formatMcpResourceTemplates,
  formatMcpResources,
  formatMcpServerList,
  formatMcpStatus,
  formatMcpTools
} from "../../../cli/mcpCommand.js";
import {
  formatSkillDetails,
  formatSkillList
} from "../../../cli/skillsCommand.js";
import type { SessionRuntime } from "../../../cli/sessionRuntime.js";
import type { TerminalUiMessage } from "../../state/types.js";
import { createErrorMessage, createSystemMessage } from "../messageMapper.js";

export type ParsedReplCommand = ReturnType<typeof parseReplCommand>;
export type SkillsParsedCommand = Extract<
  ParsedReplCommand,
  {
    type: "skills-list" | "skills-view" | "skills-set-enabled" | "skills-refresh";
  }
>;
export type McpParsedCommand = Extract<
  ParsedReplCommand,
  {
    type:
      | "mcp-list"
      | "mcp-status"
      | "mcp-tools"
      | "mcp-resources"
      | "mcp-prompts"
      | "mcp-prompt"
      | "mcp-templates"
      | "mcp-add"
      | "mcp-remove"
      | "mcp-set-enabled"
      | "mcp-login";
  }
>;
export type TrustParsedCommand = Extract<
  ParsedReplCommand,
  {
    type: "trust-status" | "project-trust-set";
  }
>;

export function isSkillsParsedCommand(command: ParsedReplCommand): command is SkillsParsedCommand {
  return command.type.startsWith("skills-");
}

export function isMcpParsedCommand(command: ParsedReplCommand): command is McpParsedCommand {
  return command.type.startsWith("mcp-");
}

export function isTrustParsedCommand(command: ParsedReplCommand): command is TrustParsedCommand {
  return command.type === "trust-status" || command.type === "project-trust-set";
}

export interface WorkspaceCommandHandlers {
  handleSkillsCommand: (parsedCommand: SkillsParsedCommand) => Promise<void>;
  handleMcpCommand: (parsedCommand: McpParsedCommand) => Promise<void>;
  handleTrustCommand: (parsedCommand: TrustParsedCommand) => Promise<void>;
}

export function createWorkspaceCommandHandlers(deps: {
  runtime: SessionRuntime;
  appendUiMessage: (message: TerminalUiMessage) => void;
}): WorkspaceCommandHandlers {
  const { runtime, appendUiMessage } = deps;

  const appendSystemText = (content: string, title: string) => {
    appendUiMessage(createSystemMessage(content, title));
  };

  const withOptionalServerName = (serverName?: string) =>
    serverName ? { serverName } : {};

  const doesPathExist = async (targetPath: string) => {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  };

  const isDirectoryReady = async (targetPath: string) => {
    try {
      const stat = await fs.stat(targetPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  };

  const getSkillCommandContext = async () => {
    const projectRoot = runtime.config.paths.projectSkillsDirectory;
    const userRoot = runtime.config.paths.userSkillsDirectory;
    const [projectRootReady, userRootReady] = await Promise.all([
      isDirectoryReady(projectRoot),
      isDirectoryReady(userRoot)
    ]);
    return {
      projectRoot,
      userRoot,
      projectRootReady,
      userRootReady
    };
  };

  const getMcpCommandContext = async () => {
    const projectConfigPath = path.join(runtime.config.paths.projectAlyceDirectory, "mcp.json");
    const localConfigPath = path.join(runtime.config.paths.projectAlyceDirectory, "mcp.local.json");
    const userConfigPath = path.join(runtime.config.paths.userAlyceDirectory, "mcp.json");
    const [projectConfigExists, localConfigExists, userConfigExists] = await Promise.all([
      doesPathExist(projectConfigPath),
      doesPathExist(localConfigPath),
      doesPathExist(userConfigPath)
    ]);
    return {
      projectConfigPath,
      projectConfigExists,
      localConfigPath,
      localConfigExists,
      userConfigPath,
      userConfigExists
    };
  };

  const formatProjectTrustStatus = () => {
    const state = runtime.getProjectTrustState();
    return [
      "Project trust",
      `Workspace: ${state.workspaceRoot}`,
      `Status: ${state.trusted ? "trusted" : "untrusted"}`,
      `Trust store: ${state.storePath}`,
      state.updatedAt ? `Updated: ${state.updatedAt}` : undefined,
      "",
      state.trusted
        ? "Project-local .alyce config, skills, MCP servers, agents, and connector plugins may load."
        : "Project-local .alyce config, skills, MCP servers, agents, and connector plugins are disabled."
    ].filter((line): line is string => line !== undefined).join("\n");
  };

  const findCatalogSkill = (
    catalog: Awaited<ReturnType<SessionRuntime["listSkills"]>>,
    requestedName: string
  ) => [...catalog.skills, ...catalog.disabledSkills].find((entry) =>
    entry.normalizedName === requestedName.trim().toLowerCase()
  );

  const handleSkillsCommand = async (parsedCommand: SkillsParsedCommand) => {
    switch (parsedCommand.type) {
      case "skills-list": {
        const catalog = await runtime.listSkills();
        appendSystemText(formatSkillList(catalog, await getSkillCommandContext()), "Skills");
        return;
      }
      case "skills-view": {
        const catalog = await runtime.listSkills();
        const skill = findCatalogSkill(catalog, parsedCommand.name);
        const details = formatSkillDetails(
          skill,
          parsedCommand.name,
          catalog,
          await getSkillCommandContext()
        );
        appendUiMessage(
          skill
            ? createSystemMessage(details, "Skills")
            : createErrorMessage(details)
        );
        return;
      }
      case "skills-set-enabled": {
        const result = parsedCommand.reference.kind === "bundled"
          ? await runtime.setBundledSkillsEnabled(parsedCommand.enabled, parsedCommand.target)
          : await runtime.setSkillEnabled(
              parsedCommand.reference,
              parsedCommand.enabled,
              parsedCommand.target
            );
        appendSystemText(result.message, "Skills");
        return;
      }
      case "skills-refresh": {
        const catalog = await runtime.refreshSkills();
        appendSystemText(
          [
            "Skill catalog refreshed.",
            `Active: ${catalog.skills.length}`,
            `Disabled: ${catalog.disabledSkills.length}`
          ].join("\n"),
          "Skills"
        );
        return;
      }
    }
  };

  const appendMcpAuthorizationUrl = (details: {
    server: string;
    authorizationUrl: string;
    redirectUrl: string;
  }) => {
    appendSystemText(
      [
        `Open this URL to authorize MCP server '${details.server}':`,
        details.authorizationUrl,
        `Redirect URL: ${details.redirectUrl}`
      ].join("\n"),
      "MCP"
    );
  };

  const handleMcpCommand = async (parsedCommand: McpParsedCommand) => {
    switch (parsedCommand.type) {
      case "mcp-list": {
        const status = await runtime.getMcpStatus({ initialize: false });
        appendSystemText(formatMcpServerList(status, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-status": {
        const status = await runtime.getMcpStatus({ initialize: true });
        appendSystemText(formatMcpStatus(status, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-tools": {
        const result = await runtime.listMcpTools(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(formatMcpTools(result, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-resources": {
        const result = await runtime.listMcpResources(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(formatMcpResources(result, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-prompts": {
        const result = await runtime.listMcpPrompts(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(formatMcpPrompts(result, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-prompt": {
        const result = await runtime.getMcpPrompt(
          parsedCommand.serverName,
          parsedCommand.promptName,
          parsedCommand.args
        );
        appendSystemText(formatMcpPrompt(result), "MCP");
        return;
      }
      case "mcp-templates": {
        const result = await runtime.listMcpResourceTemplates(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(
          formatMcpResourceTemplates(result, await getMcpCommandContext()),
          "MCP"
        );
        return;
      }
      case "mcp-add": {
        const result = await runtime.addMcpServer(
          parsedCommand.name,
          parsedCommand.config,
          parsedCommand.scope
        );
        appendSystemText(formatMcpMutation("add", result), "MCP");
        return;
      }
      case "mcp-remove": {
        const result = await runtime.removeMcpServer(parsedCommand.name, parsedCommand.scope);
        appendSystemText(formatMcpMutation("remove", result), "MCP");
        return;
      }
      case "mcp-set-enabled": {
        const result = await runtime.setMcpServerEnabled(
          parsedCommand.name,
          parsedCommand.enabled,
          parsedCommand.scope
        );
        appendSystemText(
          formatMcpMutation(parsedCommand.enabled ? "enable" : "disable", result),
          "MCP"
        );
        return;
      }
      case "mcp-login": {
        const result = await runtime.loginMcpServer(parsedCommand.serverName, {
          onAuthorizationUrl: appendMcpAuthorizationUrl
        });
        appendSystemText(formatMcpLoginResult(result), "MCP");
        return;
      }
    }
  };

  const handleTrustCommand = async (parsedCommand: TrustParsedCommand) => {
    if (parsedCommand.type === "trust-status") {
      appendSystemText(formatProjectTrustStatus(), "Trust");
      return;
    }

    const next = await runtime.setProjectTrusted(parsedCommand.trusted);
    await runtime.refreshSkills();
    await runtime.getMcpStatus({ initialize: false });
    appendSystemText(
      [
        parsedCommand.trusted
          ? "Workspace trusted."
          : "Workspace trust revoked.",
        `Workspace: ${next.workspaceRoot}`,
        `Trust store: ${next.storePath}`,
        parsedCommand.trusted
          ? "Project-local Alyce assets will be considered on subsequent loads."
          : "Project-local Alyce assets are disabled for this session."
      ].join("\n"),
      "Trust"
    );
  };

  return {
    handleSkillsCommand,
    handleMcpCommand,
    handleTrustCommand
  };
}
