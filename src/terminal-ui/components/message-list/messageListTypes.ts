import type { MarkdownRenderPlan } from "../MarkdownRenderer.js";
import type { Color } from "../../runtime/ink-runtime/styles.js";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone
} from "../../state/types.js";

export type RenderedSection = {
  label?: string;
  lines: RenderedSectionLine[];
  tone: TerminalUiMessageBlockTone;
  style: TerminalUiMessageBlockStyle;
  isDiff?: boolean;
};

export type ThemeColor = Color;
export type DiffLineKind = "meta" | "hunk" | "file" | "separator" | "add" | "remove" | "context";

export type RenderedSectionLine = {
  content: string;
  diffKind?: DiffLineKind;
  lineNumberText?: string;
};

export type RenderedMessageEntry = {
  message: TerminalUiMessage;
  isSelected: boolean;
  headerSegments: HeaderSegment[];
  sections: RenderedSection[];
  markdownPlan?: MarkdownRenderPlan;
  metadataLine?: string;
  isExpandable: boolean;
  leadingSpacingRows: number;
  unseenDividerRows: number;
  palette: MessagePalette;
  rowCount: number;
};

export type HeaderSegment = {
  text: string;
  color: ThemeColor;
};

export type MessagePalette = {
  headerColor: ThemeColor;
  bodyColor: ThemeColor;
  mutedColor: ThemeColor;
  railColor: ThemeColor;
};

export type ScrollIndicatorState = {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
  visible: boolean;
  active: boolean;
};

export type ScrollIndicatorLine = {
  key: string;
  char: string;
  color: ThemeColor;
  dimColor?: boolean;
};

export type ScrollIndicatorMetrics = {
  height: number;
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
  maxThumbTop: number;
  maxScrollTop: number;
};

export type ExpandableRenderState = {
  sections: RenderedSection[];
  metadataLine?: string;
  expandable: boolean;
};
