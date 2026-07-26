import { t } from "../../../i18n/index.js";
import type { TerminalUiMessage } from "../../state/types.js";
import { terminalUiTheme } from "../../theme/theme.js";
import type { HeaderSegment, MessagePalette, ThemeColor } from "./messageListTypes.js";

const TOOL_TARGET_HEADER_COLOR = terminalUiTheme.colors.toolTarget;

export function getMessageBadge(kind: TerminalUiMessage["kind"]) {
  switch (kind) {
    case "user":
      return { label: t("messageList.badge.user") };
    case "thinking":
      return { label: t("messageList.badge.think") };
    case "tool":
      return { label: t("messageList.badge.tool") };
    case "error":
      return { label: t("messageList.badge.error") };
    case "system":
    default:
      return { label: t("messageList.badge.system") };
  }
}

export function getMessagePalette(
  kind: TerminalUiMessage["kind"],
  isSelected: boolean
): MessagePalette {
  const makePalette = (headerColor: ThemeColor, bodyColor: ThemeColor, mutedColor: ThemeColor): MessagePalette => ({
    headerColor,
    bodyColor,
    mutedColor: isSelected ? terminalUiTheme.colors.muted : mutedColor,
    railColor: headerColor
  });

  switch (kind) {
    case "user":
      return makePalette(
        terminalUiTheme.colors.code,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "assistant":
      return makePalette(
        terminalUiTheme.colors.assistant,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "thinking":
      return makePalette(
        terminalUiTheme.colors.thinking,
        terminalUiTheme.colors.messageCardMuted,
        terminalUiTheme.colors.subtle
      );
    case "tool":
      return makePalette(
        terminalUiTheme.colors.tool,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "error":
      return makePalette(
        terminalUiTheme.colors.danger,
        terminalUiTheme.colors.messageCardText,
        terminalUiTheme.colors.muted
      );
    case "system":
    default:
      return makePalette(
        terminalUiTheme.colors.system,
        terminalUiTheme.colors.chrome,
        terminalUiTheme.colors.muted
      );
  }
}

export function buildHeaderSegments(
  message: TerminalUiMessage,
  badgeLabel: string,
  palette: MessagePalette
): HeaderSegment[] {
  const segments: HeaderSegment[] = [
    {
      text: badgeLabel,
      color: palette.headerColor
    }
  ];
  const titleSegments = buildHeaderTitleSegments(message, palette);

  if (titleSegments.length > 0) {
    segments.push(
      {
        text: " · ",
        color: palette.mutedColor
      },
      ...titleSegments
    );
  }

  return segments;
}

function buildHeaderTitleSegments(
  message: TerminalUiMessage,
  palette: MessagePalette
): HeaderSegment[] {
  if (message.kind === "user" || message.kind === "assistant") {
    return [];
  }

  if (message.kind === "tool") {
    return buildToolHeaderTitleSegments(message, palette);
  }

  return [
    {
      text: message.title,
      color: palette.headerColor
    }
  ];
}

function buildToolHeaderTitleSegments(
  message: TerminalUiMessage,
  palette: MessagePalette
): HeaderSegment[] {
  const shellCommand = message.toolData?.ok === true &&
    message.toolData.resultKind === "shell"
    ? message.toolData.shell?.command
    : undefined;
  if (shellCommand) {
    return [
      {
        text: "Ran ",
        color: terminalUiTheme.colors.chrome
      },
      ...buildShellCommandHeaderSegments(shellCommand, palette)
    ];
  }

  const title = message.title.trim();
  if (title.length === 0) {
    return [];
  }

  const splitTitle = splitFirstWhitespace(title);
  if (!splitTitle) {
    return [
      {
        text: title,
        color: terminalUiTheme.colors.chrome
      }
    ];
  }

  return [
    {
      text: splitTitle.head,
      color: terminalUiTheme.colors.chrome
    },
    {
      text: " ",
      color: palette.mutedColor
    },
    {
      text: splitTitle.tail,
      color: TOOL_TARGET_HEADER_COLOR
    }
  ];
}

export function buildShellCommandHeaderSegments(
  command: string,
  palette: MessagePalette
): HeaderSegment[] {
  const tokens = splitShellCommand(command);
  if (tokens.length === 0) {
    return [
      {
        text: command,
        color: terminalUiTheme.colors.code
      }
    ];
  }

  return tokens.flatMap((token, index) => {
    const prefix = index === 0
      ? []
      : [
          {
            text: " ",
            color: palette.mutedColor
          }
        ];

    if (index > 0 && isPathLikeToolTarget(token)) {
      return [
        ...prefix,
        {
          text: token,
          color: TOOL_TARGET_HEADER_COLOR
        }
      ];
    }

    return [
      ...prefix,
      {
        text: token,
        color: getShellCommandTokenColor(token, index)
      }
    ];
  });
}

function getShellCommandTokenColor(token: string, index: number): ThemeColor {
  if (index === 0) {
    return terminalUiTheme.colors.tool;
  }

  if (/^-{1,2}\S+/.test(token)) {
    return terminalUiTheme.colors.system;
  }

  if (/^["']/.test(token)) {
    return terminalUiTheme.colors.markdownQuote;
  }

  return terminalUiTheme.colors.code;
}

function isPathLikeToolTarget(token: string) {
  const unquoted = token.replace(/^["']|["']$/g, "");
  return /^[A-Za-z]:[\\/]/.test(unquoted) ||
    unquoted.startsWith("~/") ||
    unquoted.startsWith("~\\") ||
    unquoted.startsWith("./") ||
    unquoted.startsWith(".\\") ||
    unquoted.startsWith("../") ||
    unquoted.startsWith("..\\") ||
    unquoted.includes("/") ||
    unquoted.includes("\\");
}

function splitShellCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function splitFirstWhitespace(value: string): { head: string; tail: string } | null {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(value);
  if (!match) {
    return null;
  }

  return {
    head: match[1]!,
    tail: match[2]!
  };
}
