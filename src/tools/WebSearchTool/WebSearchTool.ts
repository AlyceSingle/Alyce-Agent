import { z } from "zod";
import { truncate } from "../internal/values.js";
import type { ToolExecutionContext } from "../types.js";
import { WEB_SEARCH_TOOL_DESCRIPTION, WEB_SEARCH_TOOL_NAME } from "./prompt.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;

export const WebSearchInputSchema = z
  .object({
    query: z.string().min(2).describe("Search query text"),
    allowed_domains: z.array(z.string()).optional().describe("Only keep results from these domains"),
    blocked_domains: z.array(z.string()).optional().describe("Remove results from these domains"),
    max_results: z
      .number()
      .int()
      .positive()
      .max(MAX_RESULTS)
      .optional()
      .describe("Maximum number of results to return")
  })
  .strict()
  .refine((value) => !(value.allowed_domains && value.blocked_domains), {
    message: "allowed_domains and blocked_domains cannot be used together"
  });

export { WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_DESCRIPTION };

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  engine: string;
  resultCount: number;
  results: WebSearchItem[];
}

export async function executeWebSearchTool(
  input: z.infer<typeof WebSearchInputSchema>,
  context: ToolExecutionContext
): Promise<WebSearchResult> {
  const approved = await context.requestApproval(`search web: ${input.query}`);
  if (!approved) {
    throw new Error("User rejected WebSearch tool request");
  }

  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
  const html = await fetchDuckDuckGoHtml(input.query, context.commandTimeoutMs);

  const parsed = parseDuckDuckGoResults(html)
    .filter((item) => passesDomainFilter(item.url, input.allowed_domains, input.blocked_domains))
    .slice(0, maxResults);

  return {
    query: input.query,
    engine: "duckduckgo-html",
    resultCount: parsed.length,
    results: parsed
  };
}

async function fetchDuckDuckGoHtml(query: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "AlyceAgent/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`WebSearch request failed with status ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`WebSearch timed out after ${timeoutMs} ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseDuckDuckGoResults(html: string): WebSearchItem[] {
  const results: WebSearchItem[] = [];
  const linkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  const seenUrls = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(match[1] ?? "").trim();
    const title = collapseWhitespace(stripTags(decodeHtmlEntities(match[2] ?? "")));

    const url = normalizeSearchResultUrl(rawHref);
    if (!url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);

    const snippet = collapseWhitespace(extractSnippetAfter(html, linkPattern.lastIndex));
    results.push({
      title: title.length > 0 ? title : url,
      url,
      snippet: truncate(snippet, 400)
    });
  }

  return results;
}

function extractSnippetAfter(html: string, startIndex: number): string {
  const nearby = html.slice(startIndex, startIndex + 1_200);
  const snippetMatch = nearby.match(
    /<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i
  );

  if (!snippetMatch) {
    return "";
  }

  return stripTags(decodeHtmlEntities(snippetMatch[1] ?? ""));
}

function normalizeSearchResultUrl(rawHref: string): string | null {
  if (!rawHref) {
    return null;
  }

  try {
    // DuckDuckGo 结果经常使用 /l/?uddg=... 形式，需先解出真实链接。
    const wrappedUrl = new URL(rawHref, "https://duckduckgo.com");
    const uddg = wrappedUrl.searchParams.get("uddg");
    const target = uddg ? decodeURIComponent(uddg) : wrappedUrl.toString();
    const parsedTarget = new URL(target);

    return parsedTarget.toString();
  } catch {
    return null;
  }
}

function passesDomainFilter(
  rawUrl: string,
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined
): boolean {
  let hostname: string;

  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  const normalizedAllowed = (allowedDomains ?? []).map(normalizeDomain);
  const normalizedBlocked = (blockedDomains ?? []).map(normalizeDomain);

  if (normalizedAllowed.length > 0 && !normalizedAllowed.some((domain) => isDomainMatch(hostname, domain))) {
    return false;
  }

  if (normalizedBlocked.length > 0 && normalizedBlocked.some((domain) => isDomainMatch(hostname, domain))) {
    return false;
  }

  return true;
}

function normalizeDomain(rawDomain: string): string {
  return rawDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function isDomainMatch(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
