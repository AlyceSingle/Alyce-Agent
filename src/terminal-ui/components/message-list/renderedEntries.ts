import {
  buildMarkdownRenderPlan,
  type MarkdownRenderPlan
} from "../MarkdownRenderer.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock
} from "../../state/types.js";
import {
  getRenderableToolBlocks,
  isContextPreviewMessage
} from "../../utils/messageBlocks.js";
import { normalizeMarkdownInput } from "../../utils/htmlEntities.js";
import {
  resolveMessageRenderDecision,
  type RenderPolicy
} from "../../utils/renderPolicy.js";
import {
  buildHeaderSegments,
  getMessageBadge,
  getMessagePalette
} from "./headerSegments.js";
import { countRenderedSectionRows, renderSections } from "./sectionRendering.js";
import {
  buildCollapsedToolBlocks,
  isCollapsibleSystemMessage,
  isMessageExpanded,
  renderCollapsibleSystemMessageState,
  renderContextPreviewMessageState,
  renderThinkingMessageState,
  renderToolMessageState
} from "./expandableState.js";
import type { RenderedMessageEntry } from "./messageListTypes.js";

const MIN_NON_VIRTUALIZED_MESSAGE_CAP = 20;
const WINDOW_ANCHOR_HEADROOM_RATIO = 0.75;

function buildToolMarkdownContent(
  blocks: readonly TerminalUiMessageBlock[]
): string | null {
  const sections = blocks.flatMap((block) => {
    const normalizedContent = normalizeMarkdownInput(block.content);
    if (normalizedContent.trim().length === 0) {
      return [];
    }

    if (!block.label) {
      return [normalizedContent];
    }

    return [`### ${block.label}\n\n${normalizedContent}`];
  });

  if (sections.length === 0) {
    return null;
  }

  return sections.join("\n\n");
}

function buildMarkdownPlanSafely(
  source: string,
  width: number,
  live: boolean,
  policyVersion: string
): MarkdownRenderPlan | undefined {
  try {
    return buildMarkdownRenderPlan(source, width, {
      live,
      policyVersion
    });
  } catch {
    return undefined;
  }
}

export type RenderedEntryCacheRecord = {
  signature: string;
  entry: RenderedMessageEntry;
  sectionRowCount: number;
  hasMetadataLine: boolean;
};

function buildMessageRenderSignature(
  message: TerminalUiMessage,
  isSelected: boolean,
  contentWidth: number,
  isExpanded: boolean,
  isLiveMarkdown: boolean,
  assistantLabel: string
): string {
  return [
    message.id,
    message.kind,
    message.content,
    message.preview,
    message.metadata.join(""),
    message.title,
    isSelected ? "1" : "0",
    String(contentWidth),
    isExpanded ? "1" : "0",
    isLiveMarkdown ? "1" : "0",
    assistantLabel,
    message.toolData ? JSON.stringify(message.toolData) : ""
  ].join(" ");
}

export function buildRenderedMessageEntries(
  messages: TerminalUiMessage[],
  selectedMessageId: string | null,
  contentWidth: number,
  renderPolicy: RenderPolicy,
  expandedMessageIds: ReadonlySet<string>,
  assistantLabel: string,
  unseenDividerMessageId: string | null,
  liveMarkdownMessageId: string | null,
  thinkingMessagesExpandedByDefault = false,
  entryCache?: Map<string, RenderedEntryCacheRecord>
): RenderedMessageEntry[] {
  if (entryCache) {
    const alive = new Set(messages.map((message) => message.id));
    for (const key of entryCache.keys()) {
      if (!alive.has(key)) {
        entryCache.delete(key);
      }
    }
  }

  return messages.map((message, index) => {
    const isSelected = message.id === selectedMessageId;
    const isExpanded = isMessageExpanded(
      message,
      expandedMessageIds,
      thinkingMessagesExpandedByDefault
    );
    const isLiveMarkdown = message.id === liveMarkdownMessageId;
    const signature = buildMessageRenderSignature(
      message,
      isSelected,
      contentWidth,
      isExpanded,
      isLiveMarkdown,
      assistantLabel
    );
    const cached = entryCache?.get(message.id);
    if (cached && cached.signature === signature) {
      const leadingSpacingRows = index === 0 ? 0 : 1;
      const unseenDividerRows = message.id === unseenDividerMessageId ? 1 : 0;
      return {
        ...cached.entry,
        message,
        isSelected,
        leadingSpacingRows,
        unseenDividerRows,
        rowCount:
          leadingSpacingRows +
          unseenDividerRows +
          1 +
          cached.sectionRowCount +
          (cached.hasMetadataLine ? 1 : 0)
      };
    }
    const badge =
      message.kind === "assistant"
        ? { label: assistantLabel }
        : getMessageBadge(message.kind);
    const palette = getMessagePalette(message.kind, isSelected);
    const bodyWidth = Math.max(16, contentWidth);
    const expandableRenderState =
      message.kind === "tool"
        ? renderToolMessageState(message, contentWidth, isExpanded)
        : message.kind === "thinking"
          ? renderThinkingMessageState(message, contentWidth, isExpanded)
          : isContextPreviewMessage(message)
            ? renderContextPreviewMessageState(message, contentWidth, isExpanded)
            : isCollapsibleSystemMessage(message)
              ? renderCollapsibleSystemMessageState(message, contentWidth, isExpanded)
              : null;
    const resolveRenderDecision = (markdownSource: string) => resolveMessageRenderDecision({
      policy: renderPolicy,
      message,
      expanded: isExpanded,
      hasExpandablePreview: expandableRenderState?.expandable ?? false,
      live: message.id === liveMarkdownMessageId,
      markdownSource
    });
    let markdownSource = message.content;
    let renderDecision = resolveRenderDecision(markdownSource);

    if (message.kind === "tool" && message.toolData) {
      const shouldResolveToolMarkdownSource =
        renderDecision.mode === "markdown" || renderDecision.fallbackReason === "content-too-long";

      if (shouldResolveToolMarkdownSource) {
        const nextToolMarkdownSource = buildToolMarkdownContent(
          isExpanded
            ? getRenderableToolBlocks(message.blocks, message.toolData)
            : buildCollapsedToolBlocks(message, message.toolData, bodyWidth).blocks
        );

        if (nextToolMarkdownSource) {
          markdownSource = nextToolMarkdownSource;
          renderDecision = resolveRenderDecision(markdownSource);
        }
      }
    }

    const markdownPlan = renderDecision.mode === "markdown"
      ? buildMarkdownPlanSafely(
          markdownSource,
          bodyWidth,
          renderDecision.live,
          renderPolicy.version
        )
      : undefined;
    const sections = markdownPlan
      ? []
      : expandableRenderState?.sections ?? renderSections(message.blocks, contentWidth);
    const metadataLine =
      expandableRenderState?.metadataLine ??
      (message.metadata.length > 0 ? message.metadata.join(" | ") : undefined);
    const leadingSpacingRows = index === 0 ? 0 : 1;
    const unseenDividerRows = message.id === unseenDividerMessageId ? 1 : 0;
    const sectionRowCount = markdownPlan
        ? markdownPlan.rowCount
        : countRenderedSectionRows(sections);

    const entry: RenderedMessageEntry = {
      message,
      isSelected,
      headerSegments: buildHeaderSegments(message, badge.label, palette),
      sections,
      markdownPlan,
      metadataLine,
      isExpandable: expandableRenderState?.expandable ?? false,
      leadingSpacingRows,
      unseenDividerRows,
      palette,
      rowCount:
        leadingSpacingRows +
        unseenDividerRows +
        1 +
        sectionRowCount +
        (metadataLine ? 1 : 0)
    };
    entryCache?.set(message.id, {
      signature,
      entry,
      sectionRowCount,
      hasMetadataLine: Boolean(metadataLine)
    });
    return entry;
  });
}

function clampNonVirtualizedMessageCap(value: number) {
  if (!Number.isFinite(value)) {
    return MIN_NON_VIRTUALIZED_MESSAGE_CAP;
  }

  return Math.max(MIN_NON_VIRTUALIZED_MESSAGE_CAP, Math.trunc(value));
}

export function sliceMessagesForNonVirtualizedList(options: {
  messages: TerminalUiMessage[];
  maxMessages: number;
  sticky: boolean;
  visibleMessageId: string | null;
  selectedMessageId: string | null;
  unseenDividerMessageId: string | null;
}) {
  const cap = clampNonVirtualizedMessageCap(options.maxMessages);
  if (options.messages.length <= cap) {
    return options.messages;
  }

  if (options.sticky) {
    return options.messages.slice(options.messages.length - cap);
  }

  const lastMessageId = options.messages.at(-1)?.id ?? null;
  const selectedAnchorCandidate =
    options.selectedMessageId && options.selectedMessageId !== lastMessageId
      ? options.selectedMessageId
      : null;
  const anchorCandidates = [
    selectedAnchorCandidate,
    options.visibleMessageId,
    options.unseenDividerMessageId,
    options.selectedMessageId,
    lastMessageId
  ].filter((value): value is string => Boolean(value));

  let anchorIndex = -1;
  for (const candidate of anchorCandidates) {
    const index = options.messages.findIndex((message) => message.id === candidate);
    if (index >= 0) {
      anchorIndex = index;
      break;
    }
  }

  if (anchorIndex < 0) {
    return options.messages.slice(options.messages.length - cap);
  }

  const headroom = Math.max(1, Math.floor(cap * WINDOW_ANCHOR_HEADROOM_RATIO));
  const maxStart = options.messages.length - cap;
  const unclampedStart = anchorIndex - headroom;
  const start = Math.max(0, Math.min(unclampedStart, maxStart));
  return options.messages.slice(start, start + cap);
}
