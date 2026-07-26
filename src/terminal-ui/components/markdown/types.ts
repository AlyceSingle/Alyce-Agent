export type MarkdownToken = {
  type: string;
} & Record<string, unknown>;

export type MarkdownSpanStyle = {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
  href?: string;
};

export type MarkdownSpan = MarkdownSpanStyle & {
  text: string;
  href?: string;
};

export type MarkdownCharacter = MarkdownSpanStyle & {
  char: string;
  href?: string;
};

export type MarkdownLineVariant =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "quote"
  | "list"
  | "code"
  | "code-label"
  | "math"
  | "rule"
  | "table"
  | "table-divider";

export interface MarkdownRenderLine {
  key: string;
  indent: number;
  prefix: string;
  spans: MarkdownSpan[];
  variant: MarkdownLineVariant;
  quoteDepth?: number;
}

export interface MarkdownRenderBlock {
  key: string;
  marginTop: number;
  lines: MarkdownRenderLine[];
}

export interface MarkdownRenderPlan {
  blocks: MarkdownRenderBlock[];
  rowCount: number;
}

export interface BuildMarkdownRenderPlanOptions {
  live?: boolean;
  policyVersion?: string;
}

export type MarkdownTableCell = {
  text: string;
  align?: "left" | "center" | "right" | null;
  spans: MarkdownSpan[];
  header: boolean;
};
