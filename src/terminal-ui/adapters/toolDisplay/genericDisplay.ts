import type { TerminalUiMessageBlock } from "../../state/types.js";
import {
  asRecord,
  asRecordArray,
  asString,
  asStringArray,
  createBlock,
  MARKDOWN_FRIENDLY_TOOL_NAME_TOKENS
} from "./common.js";

// 列表/搜索类工具的通用 markdown 输出。

export function buildMarkdownFriendlyGenericBlocks(
  toolName: string,
  structuredResult: unknown
): TerminalUiMessageBlock[] | null {
  if (!isMarkdownFriendlyToolName(toolName)) {
    return null;
  }

  if (typeof structuredResult === "string") {
    return [createBlock(structuredResult, { label: "Output", tone: "success" })];
  }

  const record = asRecord(structuredResult);
  if (!record) {
    return null;
  }

  const content = extractMarkdownFriendlyToolContent(record);
  if (!content) {
    return null;
  }

  const blocks: TerminalUiMessageBlock[] = [
    createBlock(content, { label: "Output", tone: "success" })
  ];
  const warnings = asStringArray(record.warnings);
  if (warnings.length > 0) {
    blocks.push(createBlock(warnings.map((warning) => `- ${warning}`).join("\n"), {
      label: "Warnings",
      tone: "warning"
    }));
  }

  return blocks;
}

export function extractMarkdownFriendlyToolContent(record: Record<string, unknown>): string | null {
  const directContent = asString(record.content)?.trim();
  if (directContent) {
    return directContent;
  }

  const text = asString(record.text)?.trim();
  if (text) {
    return text;
  }

  const filenames = asStringArray(record.filenames);
  if (filenames.length > 0) {
    return filenames.map((filename) => `- \`${filename}\``).join("\n");
  }

  const items = asStringArray(record.items);
  if (items.length > 0) {
    return items.map((item) => `- ${item}`).join("\n");
  }

  const entries = asStringArray(record.entries);
  if (entries.length > 0) {
    return entries.map((entry) => `- ${entry}`).join("\n");
  }

  const searchResults = asRecordArray(record.results);
  if (searchResults.length > 0) {
    const lines = searchResults.map((item, index) => {
      const title =
        asString(item.title) ??
        asString(item.name) ??
        asString(item.url) ??
        `Result ${index + 1}`;
      const url = asString(item.url);
      const snippet = asString(item.snippet) ?? asString(item.description);
      const line = url ? `${index + 1}. [${title}](${url})` : `${index + 1}. ${title}`;
      if (!snippet || snippet.trim().length === 0) {
        return line;
      }

      return `${line}\n   ${snippet.trim()}`;
    });
    const context = asString(record.context)?.trim();
    if (context) {
      lines.push("", "Context:", context);
    }

    return lines.join("\n");
  }

  const message = asString(record.message)?.trim();
  if (message) {
    return message;
  }

  return null;
}

export function isMarkdownFriendlyToolName(toolName: string) {
  const normalizedToolName = toolName.trim().toLowerCase();
  return MARKDOWN_FRIENDLY_TOOL_NAME_TOKENS.some((token) => normalizedToolName.includes(token));
}
