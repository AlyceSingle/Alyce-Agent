import { t } from "../../../i18n/index.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockTone,
  TerminalUiToolData
} from "../../state/types.js";
import { getRenderableToolBlocks } from "../../utils/messageBlocks.js";
import { measureCharWidth, wrapTextClamped } from "../../utils/text.js";
import { countRenderedSectionRows, renderSections } from "./sectionRendering.js";
import type { ExpandableRenderState } from "./messageListTypes.js";

function isDefaultExpandedToolMessage(message: TerminalUiMessage) {
  return message.kind === "tool" &&
    message.toolData !== undefined &&
    isEditLikeToolResult(message.toolData.resultKind);
}

export function isDefaultExpandedMessage(
  message: TerminalUiMessage,
  thinkingMessagesExpandedByDefault: boolean
) {
  return isDefaultExpandedToolMessage(message) ||
    (message.kind === "thinking" && thinkingMessagesExpandedByDefault);
}

export function isMessageExpanded(
  message: TerminalUiMessage,
  expandedMessageIds: ReadonlySet<string>,
  thinkingMessagesExpandedByDefault = false
) {
  if (isDefaultExpandedMessage(message, thinkingMessagesExpandedByDefault)) {
    return !expandedMessageIds.has(message.id);
  }

  return expandedMessageIds.has(message.id);
}

export function isCollapsibleSystemMessage(message: TerminalUiMessage) {
  return message.kind === "system" && message.title !== "Startup";
}

function findFirstNonEmptyLineBlock(blocks: TerminalUiMessageBlock[]): TerminalUiMessageBlock | null {
  for (const block of blocks) {
    const firstLine = block.content
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);

    if (firstLine) {
      return {
        content: firstLine,
        tone: block.tone,
        style: block.style
      };
    }
  }

  return null;
}

function buildCollapsibleSystemPreviewBlock(message: TerminalUiMessage): TerminalUiMessageBlock {
  const blockPreview = findFirstNonEmptyLineBlock(message.blocks);
  if (blockPreview) {
    return blockPreview;
  }

  const contentPreview = message.content
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return {
    content: contentPreview ?? t("messageList.emptyOutput")
  };
}

function clampBlockToSingleRenderedLine(
  block: TerminalUiMessageBlock,
  width: number
): { block: TerminalUiMessageBlock; truncated: boolean } {
  const safeWidth = Math.max(8, width);
  let contentWidth = 0;
  for (const character of block.content) {
    contentWidth += measureCharWidth(character);
  }

  if (contentWidth <= safeWidth) {
    return { block, truncated: false };
  }

  const suffix = "...";
  const contentBudget = Math.max(0, safeWidth - suffix.length);
  let visibleContent = "";
  let visibleWidth = 0;
  for (const character of block.content) {
    const characterWidth = measureCharWidth(character);
    if (visibleWidth + characterWidth > contentBudget) {
      break;
    }

    visibleContent += character;
    visibleWidth += characterWidth;
  }

  return {
    block: {
      ...block,
      content: visibleContent.length > 0 ? `${visibleContent}${suffix}` : suffix
    },
    truncated: true
  };
}

export function renderCollapsibleSystemMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const baseMetadata = message.metadata;
  const collapsedPreview = clampBlockToSingleRenderedLine(
    buildCollapsibleSystemPreviewBlock(message),
    width
  );
  const collapsedSections = renderSections([collapsedPreview.block], width);
  const expandedSections = renderSections(message.blocks, width);
  const expandable =
    collapsedPreview.truncated ||
    countRenderedSectionRows(expandedSections) > countRenderedSectionRows(collapsedSections);
  const toggleHint = expandable
    ? expanded
      ? t("messageList.clickToCollapse")
      : t("messageList.clickToExpand")
    : undefined;

  return {
    sections: expanded ? expandedSections : collapsedSections,
    metadataLine: buildExpandableMetadataLine(baseMetadata, toggleHint),
    expandable
  };
}

export function renderToolMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const toolData = message.toolData;
  const renderableBlocks =
    !toolData || toolData.ok === false
      ? message.blocks
      : getRenderableToolBlocks(message.blocks, toolData);

  return renderHeaderOnlyExpandableState(message.metadata, renderableBlocks, width, expanded);
}

export function renderThinkingMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  return renderHeaderOnlyExpandableState(message.metadata, message.blocks, width, expanded);
}

function isEditLikeToolResult(resultKind: TerminalUiToolData["resultKind"]) {
  return resultKind === "edit" || resultKind === "write" || resultKind === "patch";
}

function renderHeaderOnlyExpandableState(
  metadata: string[],
  blocks: TerminalUiMessageBlock[],
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const expandedSections = renderSections(blocks, width);
  const expandable = countRenderedSectionRows(expandedSections) > 0;
  const toggleHint = expandable
    ? expanded
      ? t("messageList.clickToCollapse")
      : t("messageList.clickToExpand")
    : undefined;

  return {
    sections: expanded ? expandedSections : [],
    metadataLine: buildExpandableMetadataLine(metadata, toggleHint),
    expandable
  };
}

export function renderContextPreviewMessageState(
  message: TerminalUiMessage,
  width: number,
  expanded: boolean
): ExpandableRenderState {
  const baseMetadata = message.metadata;
  const collapsedPreview = buildCollapsedMessageBlocks(message.blocks, width, 16);
  const sections = renderSections(expanded ? message.blocks : collapsedPreview.blocks, width);
  const toggleHint = collapsedPreview.truncated
    ? expanded
      ? t("messageList.clickToCollapse")
      : t("messageList.clickToExpand")
    : undefined;

  return {
    sections,
    metadataLine: buildExpandableMetadataLine(baseMetadata, toggleHint),
    expandable: Boolean(toggleHint)
  };
}

export function buildCollapsedMessageBlocks(
  blocks: TerminalUiMessageBlock[],
  width: number,
  maxLines: number
): {
  blocks: TerminalUiMessageBlock[];
  truncated: boolean;
} {
  const safeWidth = Math.max(16, width);
  const previewBlocks: TerminalUiMessageBlock[] = [];
  let remainingLines = maxLines;
  let truncated = false;

  for (const block of blocks) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    const preview = wrapTextClamped(block.content, safeWidth, remainingLines);
    previewBlocks.push({
      ...block,
      content: preview.lines.join("\n")
    });

    truncated ||= preview.truncated;
    remainingLines -= preview.lines.length;
    if (preview.truncated) {
      break;
    }
  }

  if (previewBlocks.length === 0) {
    previewBlocks.push({
      label: t("messageList.output"),
      content: t("messageList.emptyOutput"),
      tone: "muted"
    });
  }

  return {
    blocks: previewBlocks,
    truncated
  };
}

export function buildCollapsedToolBlocks(
  message: TerminalUiMessage,
  toolData: TerminalUiToolData,
  width: number
): {
  blocks: TerminalUiMessageBlock[];
  truncated: boolean;
} {
  switch (toolData.resultKind) {
    case "shell": {
      const shell = toolData.shell;
      if (!shell) {
        break;
      }

      const blocks: TerminalUiMessageBlock[] = [
        {
          label: t("messageList.command"),
          content: `$ ${shell.command}`,
          style: "code"
        }
      ];
      const combinedOutput = combineShellOutput(shell.stdout, shell.stderr);
      if (!combinedOutput) {
        blocks.push({
          content: t("messageList.noOutput"),
          tone: "muted"
        });
        return buildCollapsedMessageBlocks(blocks, width, 3);
      }

      blocks.push({
        label: combinedOutput.label,
        content: combinedOutput.text,
        style: "code",
        tone: combinedOutput.tone
      });
      return buildCollapsedMessageBlocks(blocks, width, 3);
    }
    case "read":
      return buildCollapsedMessageBlocks(message.blocks, width, 3);
    case "generic":
      return buildCollapsedMessageBlocks(message.blocks, width, 3);
    case "write":
    case "edit":
    default: {
      return buildCollapsedMessageBlocks(message.blocks, width, 12);
    }
  }

  return buildCollapsedMessageBlocks(message.blocks, width, 12);
}

export function combineShellOutput(stdout: string, stderr: string): {
  label: string;
  text: string;
  tone?: TerminalUiMessageBlockTone;
} | null {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout && trimmedStderr) {
    return {
      label: t("messageList.output"),
      text: `${trimmedStdout}\n\n[stderr]\n${trimmedStderr}`,
      tone: "warning"
    };
  }

  if (trimmedStdout) {
    return {
      label: t("messageList.stdout"),
      text: trimmedStdout,
      tone: "success"
    };
  }

  if (trimmedStderr) {
    return {
      label: t("messageList.stderr"),
      text: trimmedStderr,
      tone: "warning"
    };
  }

  return null;
}

function buildExpandableMetadataLine(metadata: string[], toggleHint?: string) {
  const parts = toggleHint ? [...metadata, toggleHint] : metadata;
  return parts.length > 0 ? parts.join(" | ") : undefined;
}
