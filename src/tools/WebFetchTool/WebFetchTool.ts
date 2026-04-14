import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { truncate } from "../internal/values.js";
import type { ToolExecutionContext } from "../types.js";
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from "./prompt.js";

const DEFAULT_MAX_CHARS = 8_000;
const MAX_MAX_CHARS = 40_000;

export const WebFetchInputSchema = z
  .object({
    url: z.string().url().describe("Public URL to fetch"),
    prompt: z.string().optional().describe("Optional extraction hint"),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(MAX_MAX_CHARS)
      .optional()
      .describe("Maximum number of characters to return")
  })
  .strict();

export const WEB_FETCH_TOOL_DESCRIPTION = DESCRIPTION;
export { WEB_FETCH_TOOL_NAME };

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  bytes: number;
  content: string;
  truncated: boolean;
  promptApplied: boolean;
}

export async function executeWebFetchTool(
  input: z.infer<typeof WebFetchInputSchema>,
  context: ToolExecutionContext
): Promise<WebFetchResult> {
  throwIfAborted(context.abortSignal);

  const normalizedUrl = normalizeUrl(input.url);
  const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
  const timeoutMs = Math.max(1, context.commandTimeoutMs);

  const approved = await context.requestApproval({
    kind: "web",
    toolName: WEB_FETCH_TOOL_NAME,
    title: "Fetch web content",
    summary: normalizedUrl,
    details: [`Max chars: ${maxChars}`, `Prompt filter: ${input.prompt ? "yes" : "no"}`]
  });
  if (!approved) {
    throw new Error("User rejected WebFetch tool request");
  }

  throwIfAborted(context.abortSignal);

  const response = await fetchWithTimeout(normalizedUrl, timeoutMs, context.abortSignal);
  const rawBody = await response.text();
  const contentType = response.headers.get("content-type") ?? "unknown";

  const plainText = normalizeBody(rawBody, contentType);
  const focusedText = input.prompt ? applyPromptHeuristic(plainText, input.prompt) : plainText;

  return {
    url: normalizedUrl,
    finalUrl: response.url || normalizedUrl,
    status: response.status,
    statusText: response.statusText,
    contentType,
    bytes: Buffer.byteLength(rawBody, "utf8"),
    content: truncate(focusedText, maxChars),
    truncated: focusedText.length > maxChars,
    promptApplied: Boolean(input.prompt)
  };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const handleAbort = () => controller.abort(parentSignal?.reason);

  try {
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener("abort", handleAbort, { once: true });
    }

    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "AlyceAgent/0.1"
      }
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`WebFetch timed out after ${timeoutMs} ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", handleAbort);
  }
}

function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }

  return parsed.toString();
}

function normalizeBody(rawBody: string, contentType: string): string {
  if (contentType.toLowerCase().includes("text/html")) {
    return htmlToText(rawBody);
  }

  return rawBody;
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "\n")
      .replace(/<!--([\s\S]*?)-->/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function applyPromptHeuristic(content: string, prompt: string): string {
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) {
    return content;
  }

  // 轻量关键词提取：优先返回与 prompt 相关的行，减少无关噪声。
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const matched = lines.filter((line) => {
    const normalized = line.toLowerCase();
    return keywords.some((keyword) => normalized.includes(keyword));
  });

  if (matched.length === 0) {
    return content;
  }

  return matched.slice(0, 160).join("\n");
}

function extractKeywords(prompt: string): string[] {
  const tokens = prompt.toLowerCase().match(/[a-z0-9_]{3,}|[\u4e00-\u9fa5]{2,}/g) ?? [];
  return [...new Set(tokens)].slice(0, 16);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
