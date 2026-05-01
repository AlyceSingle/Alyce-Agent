import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiToolData
} from "../state/types.js";

export function serializeMessageBlocks(blocks: readonly TerminalUiMessageBlock[]) {
  return blocks
    .map((block) => {
      if (!block.label) {
        return block.content;
      }

      return `${block.label}\n${block.content}`;
    })
    .join("\n\n");
}

export function isContextPreviewMessage(
  message: Pick<TerminalUiMessage, "kind" | "title">
) {
  return message.kind === "system" && message.title === "Context Preview";
}

export function isDiffPatchBlock(block: TerminalUiMessageBlock) {
  return block.style === "code" && block.label === "Patch";
}

export function getRenderableToolBlocks(
  blocks: readonly TerminalUiMessageBlock[],
  toolData: TerminalUiToolData
): TerminalUiMessageBlock[] {
  if (toolData.resultKind !== "edit" && toolData.resultKind !== "write") {
    return [...blocks];
  }

  if (toolData.resultKind === "write") {
    return normalizeWriteToolBlocks(blocks);
  }

  return blocks.filter((block) => block.label !== "Edit" && block.label !== "Content");
}

export function getRenderableMessageBlocks(message: TerminalUiMessage) {
  if (
    message.kind === "tool" &&
    message.toolData &&
    (message.toolData.resultKind === "edit" || message.toolData.resultKind === "write")
  ) {
    return getRenderableToolBlocks(message.blocks, message.toolData);
  }

  return [...message.blocks];
}

export function getCopyableMessageContent(message: TerminalUiMessage) {
  const normalized = serializeMessageBlocks(getRenderableMessageBlocks(message));
  if (normalized.length > 0) {
    return normalized;
  }

  return message.content || "(empty)";
}

function normalizeWriteToolBlocks(blocks: readonly TerminalUiMessageBlock[]) {
  const filteredBlocks: TerminalUiMessageBlock[] = blocks.filter(
    (block) => block.label !== "Edit" && block.label !== "Content"
  );
  if (filteredBlocks.some(isDiffPatchBlock)) {
    return filteredBlocks;
  }

  const legacyContentBlock =
    blocks.find((block) => block.label === "Content") ??
    (blocks.length === 1 ? blocks[0] : undefined);
  if (!legacyContentBlock) {
    return filteredBlocks;
  }

  const patchBlock: TerminalUiMessageBlock = {
    ...legacyContentBlock,
    label: "Patch",
    style: "code",
    content: buildLegacyWritePatchContent(legacyContentBlock.content)
  };

  return [
    ...filteredBlocks,
    patchBlock
  ];
}

function buildLegacyWritePatchContent(content: string) {
  const normalizedContent = content === "(empty)" ? "" : content;
  const lines = normalizedContent.split(/\r?\n/);

  if (lines.length === 1 && lines[0] === "") {
    return "+";
  }

  return lines.map((line) => `+${line}`).join("\n");
}
