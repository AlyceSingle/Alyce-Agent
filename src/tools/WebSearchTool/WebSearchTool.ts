import { z } from "zod";
import { asRecord, asString } from "../../core/util/unknown.js";
import {
  isTurnInterruptedError,
  throwIfAborted,
  toTurnInterruptedError
} from "../../core/abort.js";
import { truncate } from "../internal/values.js";
import type { ToolExecutionContext } from "../types.js";
import { WEB_SEARCH_TOOL_DESCRIPTION, WEB_SEARCH_TOOL_NAME } from "./prompt.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const DEFAULT_PROVIDER: WebSearchProvider = "auto";
const SEARCH_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONTEXT_MAX_CHARS = 10_000;
const MAX_CONTEXT_MAX_CHARS = 40_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const DEFAULT_CONTACT_URL = "https://www.npmjs.com/package/alyce";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DUCKDUCKGO_SEARCH_URL = "https://html.duckduckgo.com/html/";
const BROWSER_COMPATIBLE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = `AlyceAgent/0.1 (+${DEFAULT_CONTACT_URL})`;

type WebSearchProvider = "auto" | "brave" | "exa" | "duckduckgo";
type ConcreteWebSearchProvider = Exclude<WebSearchProvider, "auto">;

interface ProviderSearchResult {
  provider: ConcreteWebSearchProvider;
  engine: string;
  results: WebSearchItem[];
  context?: string;
}

interface HttpTextResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

interface CachedProviderSearchResult {
  result: ProviderSearchResult;
  expiresAt: number;
}

interface ProviderSearchExecution {
  result: ProviderSearchResult;
  cacheHit: boolean;
}

const PROVIDER_RESULT_CACHE = new Map<string, CachedProviderSearchResult>();

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
      .describe("Maximum number of results to return"),
    provider: z
      .enum(["auto", "brave", "exa", "duckduckgo"])
      .optional()
      .describe("Optional search provider override. Defaults to ALYCE_WEB_SEARCH_PROVIDER or auto."),
    search_type: z
      .enum(["auto", "fast", "deep"])
      .optional()
      .describe("Exa search type when using the exa provider"),
    livecrawl: z
      .enum(["fallback", "preferred"])
      .optional()
      .describe("Exa live crawl mode when using the exa provider"),
    context_max_chars: z
      .number()
      .int()
      .positive()
      .max(MAX_CONTEXT_MAX_CHARS)
      .optional()
      .describe("Maximum Exa context characters optimized for LLM consumption"),
    country: z
      .string()
      .length(2)
      .optional()
      .describe("Optional Brave Search country code, such as US or CN"),
    search_lang: z
      .string()
      .min(2)
      .max(12)
      .optional()
      .describe("Optional Brave Search language code, such as en or zh-hans"),
    safe_search: z
      .enum(["off", "moderate", "strict"])
      .optional()
      .describe("Optional Brave Search safe search setting"),
    freshness: z
      .string()
      .max(32)
      .optional()
      .describe("Optional Brave Search freshness filter, such as pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD")
  })
  .strict()
  .refine((value) => !(hasNonEmptyDomainList(value.allowed_domains) && hasNonEmptyDomainList(value.blocked_domains)), {
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
  provider: ConcreteWebSearchProvider;
  engine: string;
  resultCount: number;
  results: WebSearchItem[];
  context?: string;
  warnings: string[];
  attemptedProviders: ConcreteWebSearchProvider[];
  cacheHit: boolean;
}

export async function executeWebSearchTool(
  input: z.infer<typeof WebSearchInputSchema>,
  context: ToolExecutionContext
): Promise<WebSearchResult> {
  throwIfAborted(context.abortSignal);

  const configuredProvider = resolveWebSearchProvider(input.provider);
  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

  const approved = await context.requestApproval({
    kind: "web",
    toolName: WEB_SEARCH_TOOL_NAME,
    title: "Search the web",
    summary: input.query,
    details: [
      `Provider: ${configuredProvider}`,
      `Max results: ${maxResults}`,
      `Allowed domains: ${formatDomainList(input.allowed_domains)}`,
      `Blocked domains: ${formatDomainList(input.blocked_domains)}`
    ]
  });
  if (!approved) {
    throw new Error("User rejected WebSearch tool request");
  }

  throwIfAborted(context.abortSignal);

  const attemptedProviders: ConcreteWebSearchProvider[] = [];
  const warnings: string[] = [];
  const hasFilters = hasDomainFilters(input);
  let cacheHit = false;

  for (const provider of buildProviderAttempts(configuredProvider)) {
    attemptedProviders.push(provider);

    try {
      const providerExecution = await executeCachedProviderSearch(provider, input, maxResults, context);
      cacheHit ||= providerExecution.cacheHit;
      const rawResult = providerExecution.result;
      const filteredResults = deduplicateResults(rawResult.results)
        .filter((item) => passesDomainFilter(item.url, input.allowed_domains, input.blocked_domains))
        .slice(0, maxResults);

      if (!hasUsableResult(filteredResults, rawResult.context, hasFilters)) {
        const message = hasFilters
          ? "no results after applying domain filters"
          : "no usable search results";
        if (configuredProvider === "auto") {
          warnings.push(`${provider}: ${message}`);
          continue;
        }

        throw new Error(message);
      }

      const providerContext =
        rawResult.context && !hasFilters
          ? truncate(rawResult.context, input.context_max_chars ?? DEFAULT_CONTEXT_MAX_CHARS)
          : undefined;
      const resultWarnings = [...warnings];
      if (rawResult.context && hasFilters) {
        resultWarnings.push("Provider context omitted because domain filters were applied to the result list.");
      }

      return {
        query: input.query,
        provider: rawResult.provider,
        engine: rawResult.engine,
        resultCount: filteredResults.length,
        results: filteredResults,
        context: providerContext,
        warnings: resultWarnings,
        attemptedProviders,
        cacheHit
      };
    } catch (error) {
      if (isTurnInterruptedError(error, context.abortSignal)) {
        throw toTurnInterruptedError(error, context.abortSignal);
      }

      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${provider}: ${message}`);
      if (configuredProvider !== "auto") {
        throw new Error(`WebSearch provider '${provider}' failed: ${message}`);
      }
    }
  }

  throw new Error(`WebSearch failed for all providers. ${warnings.join(" | ")}`);
}

function hasNonEmptyDomainList(domains: string[] | undefined): boolean {
  return normalizeDomainList(domains).length > 0;
}

function hasDomainFilters(input: z.infer<typeof WebSearchInputSchema>): boolean {
  return hasNonEmptyDomainList(input.allowed_domains) || hasNonEmptyDomainList(input.blocked_domains);
}

function hasUsableResult(results: WebSearchItem[], providerContext: string | undefined, hasFilters: boolean): boolean {
  return results.length > 0 || Boolean(providerContext?.trim() && !hasFilters);
}

function resolveWebSearchProvider(inputProvider: WebSearchProvider | undefined): WebSearchProvider {
  return normalizeProvider(inputProvider ?? process.env.ALYCE_WEB_SEARCH_PROVIDER ?? process.env.WEB_SEARCH_PROVIDER);
}

function normalizeProvider(rawProvider: string | undefined): WebSearchProvider {
  const normalized = (rawProvider ?? DEFAULT_PROVIDER).trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return "auto";
  }

  if (normalized === "exa" || normalized === "exa-mcp") {
    return "exa";
  }

  if (normalized === "brave" || normalized === "brave-search") {
    return "brave";
  }

  if (
    normalized === "duckduckgo" ||
    normalized === "duckduckgo-html" ||
    normalized === "ddg"
  ) {
    return "duckduckgo";
  }

  throw new Error(
    `Unsupported WebSearch provider '${rawProvider}'. Supported providers: auto, brave, exa, duckduckgo.`
  );
}

function buildProviderAttempts(provider: WebSearchProvider): ConcreteWebSearchProvider[] {
  if (provider === "auto") {
    return hasBraveSearchApiKey() ? ["brave", "exa", "duckduckgo"] : ["exa", "duckduckgo"];
  }

  return [provider];
}

async function executeCachedProviderSearch(
  provider: ConcreteWebSearchProvider,
  input: z.infer<typeof WebSearchInputSchema>,
  maxResults: number,
  context: ToolExecutionContext
): Promise<ProviderSearchExecution> {
  const cacheKey = buildProviderCacheKey(provider, input, maxResults);
  const cached = getCachedProviderResult(cacheKey);
  if (cached) {
    return {
      result: cached,
      cacheHit: true
    };
  }

  const result = await executeProviderSearch(provider, input, maxResults, context);
  setCachedProviderResult(cacheKey, result);

  return {
    result,
    cacheHit: false
  };
}

function executeProviderSearch(
  provider: ConcreteWebSearchProvider,
  input: z.infer<typeof WebSearchInputSchema>,
  maxResults: number,
  context: ToolExecutionContext
): Promise<ProviderSearchResult> {
  switch (provider) {
    case "brave":
      return fetchBraveSearch(input, maxResults, context.commandTimeoutMs, context.abortSignal);
    case "exa":
      return fetchExaMcpSearch(input, maxResults, context.commandTimeoutMs, context.abortSignal);
    case "duckduckgo":
      return fetchDuckDuckGoSearch(input.query, context.commandTimeoutMs, context.abortSignal);
  }
}

function buildProviderCacheKey(
  provider: ConcreteWebSearchProvider,
  input: z.infer<typeof WebSearchInputSchema>,
  maxResults: number
): string {
  return JSON.stringify({
    provider,
    query: normalizeQueryForCache(input.query),
    maxResults,
    searchType: input.search_type ?? "auto",
    livecrawl: input.livecrawl ?? "fallback",
    contextMaxChars: input.context_max_chars ?? DEFAULT_CONTEXT_MAX_CHARS,
    country: input.country ?? "",
    searchLang: input.search_lang ?? "",
    safeSearch: input.safe_search ?? "",
    freshness: input.freshness ?? "",
    acceptLanguage: getAcceptLanguage(),
    browserUserAgent: getBrowserCompatibleUserAgent(),
    honestUserAgent: getHonestUserAgent()
  });
}

function normalizeQueryForCache(query: string): string {
  return collapseWhitespace(query).toLowerCase();
}

function getCachedProviderResult(cacheKey: string): ProviderSearchResult | null {
  const now = Date.now();
  const cached = PROVIDER_RESULT_CACHE.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    PROVIDER_RESULT_CACHE.delete(cacheKey);
    return null;
  }

  PROVIDER_RESULT_CACHE.delete(cacheKey);
  PROVIDER_RESULT_CACHE.set(cacheKey, cached);
  return cloneProviderSearchResult(cached.result);
}

function setCachedProviderResult(cacheKey: string, result: ProviderSearchResult): void {
  const ttlMs = getCacheTtlMs();
  if (ttlMs <= 0) {
    return;
  }

  PROVIDER_RESULT_CACHE.set(cacheKey, {
    result: cloneProviderSearchResult(result),
    expiresAt: Date.now() + ttlMs
  });
  pruneProviderResultCache();
}

function pruneProviderResultCache(): void {
  const now = Date.now();
  for (const [key, value] of PROVIDER_RESULT_CACHE) {
    if (value.expiresAt <= now) {
      PROVIDER_RESULT_CACHE.delete(key);
    }
  }

  while (PROVIDER_RESULT_CACHE.size > MAX_CACHE_ENTRIES) {
    const oldestKey = PROVIDER_RESULT_CACHE.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }

    PROVIDER_RESULT_CACHE.delete(oldestKey);
  }
}

function cloneProviderSearchResult(result: ProviderSearchResult): ProviderSearchResult {
  return {
    ...result,
    results: result.results.map((item) => ({ ...item }))
  };
}

function getCacheTtlMs(): number {
  const rawValue = process.env.ALYCE_WEB_SEARCH_CACHE_TTL_MS ?? process.env.WEB_SEARCH_CACHE_TTL_MS;
  if (!rawValue?.trim()) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CACHE_TTL_MS;
  }

  return parsed;
}

function hasBraveSearchApiKey(): boolean {
  return Boolean(getBraveSearchApiKey());
}

function getBraveSearchApiKey(): string | null {
  const value = process.env.ALYCE_BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_SEARCH_API_KEY;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function fetchBraveSearch(
  input: z.infer<typeof WebSearchInputSchema>,
  maxResults: number,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<ProviderSearchResult> {
  const apiKey = getBraveSearchApiKey();
  if (!apiKey) {
    throw new Error("Brave Search API key missing. Set ALYCE_BRAVE_SEARCH_API_KEY or BRAVE_SEARCH_API_KEY.");
  }

  const response = await fetchTextWithTimeout(
    buildBraveSearchUrl(input, maxResults),
    {
      headers: {
        accept: "application/json",
        "accept-language": getAcceptLanguage(),
        "cache-control": "no-cache",
        "user-agent": getBrowserCompatibleUserAgent(),
        "x-subscription-token": apiKey
      }
    },
    timeoutMs,
    parentSignal,
    "brave"
  );

  assertOkResponse(response);

  return {
    provider: "brave",
    engine: "brave-search-api",
    results: parseBraveSearchResults(response.body)
  };
}

function buildBraveSearchUrl(input: z.infer<typeof WebSearchInputSchema>, maxResults: number): string {
  const searchParams = new URLSearchParams({
    q: input.query,
    count: String(Math.min(maxResults, 20)),
    spellcheck: "1",
    result_filter: "web",
    text_decorations: "false"
  });

  if (input.country) {
    searchParams.set("country", input.country.toUpperCase());
  }

  if (input.search_lang) {
    searchParams.set("search_lang", input.search_lang);
  }

  if (input.safe_search) {
    searchParams.set("safesearch", input.safe_search);
  }

  if (input.freshness) {
    searchParams.set("freshness", input.freshness);
  }

  return `${BRAVE_SEARCH_URL}?${searchParams.toString()}`;
}

async function fetchExaMcpSearch(
  input: z.infer<typeof WebSearchInputSchema>,
  maxResults: number,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<ProviderSearchResult> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: input.query,
        type: input.search_type ?? "auto",
        numResults: maxResults,
        livecrawl: input.livecrawl ?? "fallback",
        contextMaxCharacters: input.context_max_chars ?? DEFAULT_CONTEXT_MAX_CHARS
      }
    }
  };

  const response = await fetchTextWithTimeout(
    EXA_MCP_URL,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "accept-language": getAcceptLanguage(),
        "content-type": "application/json",
        "user-agent": getHonestUserAgent()
      },
      body: JSON.stringify(payload)
    },
    timeoutMs,
    parentSignal,
    "exa"
  );

  assertOkResponse(response);

  const context = parseExaMcpContext(response.body);
  if (!context) {
    throw new Error("Exa returned no search context");
  }

  return {
    provider: "exa",
    engine: "exa-mcp",
    results: parseSearchItemsFromText(context),
    context
  };
}

async function fetchDuckDuckGoSearch(
  query: string,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<ProviderSearchResult> {
  const searchUrl = `${DUCKDUCKGO_SEARCH_URL}?q=${encodeURIComponent(query)}`;

  let response = await fetchTextWithTimeout(
    searchUrl,
    {
      headers: getDuckDuckGoHeaders(getBrowserCompatibleUserAgent())
    },
    timeoutMs,
    parentSignal,
    "duckduckgo"
  );

  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    response = await fetchTextWithTimeout(
      searchUrl,
      {
        headers: getDuckDuckGoHeaders(getHonestUserAgent())
      },
      timeoutMs,
      parentSignal,
      "duckduckgo"
    );
  }

  assertOkResponse(response);

  return {
    provider: "duckduckgo",
    engine: "duckduckgo-html",
    results: parseDuckDuckGoResults(response.body)
  };
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  provider: ConcreteWebSearchProvider
): Promise<HttpTextResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const handleAbort = () => controller.abort(parentSignal?.reason);

  try {
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener("abort", handleAbort, { once: true });
    }

    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > SEARCH_RESPONSE_MAX_BYTES) {
      await cancelResponseBody(response);
      throw new Error(
        `WebSearch provider '${provider}' response is too large (content-length exceeds ${SEARCH_RESPONSE_MAX_BYTES} bytes)`
      );
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: await readResponseTextWithLimit(response, SEARCH_RESPONSE_MAX_BYTES)
    };
  } catch (error) {
    // 与 WebFetch 保持一致，保留“用户取消”与“超时”这两个不同语义。
    if (isTurnInterruptedError(error, parentSignal)) {
      throw toTurnInterruptedError(error, parentSignal);
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`WebSearch timed out after ${timeoutMs} ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", handleAbort);
  }
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error(`WebSearch response exceeded ${maxBytes} bytes`);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel(`WebSearch response exceeded ${maxBytes} bytes`).catch(() => undefined);
        throw new Error(`WebSearch response exceeded ${maxBytes} bytes`);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }

  await response.body.cancel().catch(() => undefined);
}

function assertOkResponse(response: HttpTextResponse): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const diagnosis = diagnoseHttpFailure(response);
  throw new Error(
    `HTTP ${response.status} ${response.statusText || ""}${diagnosis ? ` (${diagnosis})` : ""}`.trim()
  );
}

function diagnoseHttpFailure(response: HttpTextResponse): string {
  const markers = [
    response.headers.get("cf-mitigated") ? `cf-mitigated=${response.headers.get("cf-mitigated")}` : "",
    response.headers.get("x-proxy-error") ? `x-proxy-error=${response.headers.get("x-proxy-error")}` : ""
  ].filter(Boolean);
  const bodyPreview = response.body.slice(0, 800).toLowerCase();

  if (response.status === 401) {
    markers.push("authentication required");
  }

  if (response.status === 403) {
    markers.push("access denied or anti-bot challenge");
  }

  if (response.status === 429) {
    markers.push("rate limited");
  }

  if (bodyPreview.includes("captcha")) {
    markers.push("captcha detected");
  }

  if (bodyPreview.includes("unusual traffic")) {
    markers.push("unusual traffic challenge detected");
  }

  if (bodyPreview.includes("cloudflare")) {
    markers.push("cloudflare page detected");
  }

  return markers.join("; ");
}

function getDuckDuckGoHeaders(userAgent: string): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "accept-language": getAcceptLanguage(),
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent": userAgent
  };
}

function getBrowserCompatibleUserAgent(): string {
  return process.env.ALYCE_WEB_SEARCH_USER_AGENT?.trim() || BROWSER_COMPATIBLE_USER_AGENT;
}

function getHonestUserAgent(): string {
  return process.env.ALYCE_WEB_SEARCH_HONEST_USER_AGENT?.trim() || HONEST_USER_AGENT;
}

function getAcceptLanguage(): string {
  return process.env.ALYCE_WEB_SEARCH_ACCEPT_LANGUAGE?.trim() || "en-US,en;q=0.9";
}

function parseExaMcpContext(body: string): string {
  const directJsonContext = parseExaMcpJsonContext(body);
  if (directJsonContext) {
    return directJsonContext;
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    const context = parseExaMcpJsonContext(data);
    if (context) {
      return context;
    }
  }

  return "";
}

function parseExaMcpJsonContext(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const content = asRecord(asRecord(parsed)?.result)?.content;
    if (!Array.isArray(content)) {
      return "";
    }

    const textParts = content
      .map((item) => asString(asRecord(item)?.text))
      .filter((text): text is string => Boolean(text?.trim()));
    return textParts.join("\n\n").trim();
  } catch {
    return "";
  }
}

function parseBraveSearchResults(body: string): WebSearchItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Brave Search returned invalid JSON");
  }

  const webResults = asArray(asRecord(asRecord(parsed)?.web)?.results);
  if (!webResults) {
    return [];
  }

  const results: WebSearchItem[] = [];
  const seenUrls = new Set<string>();

  for (const item of webResults) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }

    const url = normalizePublicUrl(asString(record.url) ?? "");
    if (!url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    const title = cleanSearchText(asString(record.title) ?? "") || hostnameTitle(url);
    const description = cleanSearchText(asString(record.description) ?? "");
    const extraSnippets = asArray(record.extra_snippets)
      ?.map((snippet) => cleanSearchText(asString(snippet) ?? ""))
      .filter(Boolean)
      .join(" ");

    results.push({
      title,
      url,
      snippet: truncate(collapseWhitespace([description, extraSnippets].filter(Boolean).join(" ")), 400)
    });
  }

  return results;
}

function cleanSearchText(value: string): string {
  return collapseWhitespace(stripTags(decodeHtmlEntities(value)));
}

function parseSearchItemsFromText(text: string): WebSearchItem[] {
  const results = parseStructuredSearchItemsFromText(text);
  const seenUrls = new Set<string>();
  for (const result of results) {
    seenUrls.add(result.url);
  }

  const markdownLinkPattern = /\[([^\]\n]{1,240})\]\((https?:\/\/[^\s)]+)\)/gi;
  let markdownMatch: RegExpExecArray | null;

  while ((markdownMatch = markdownLinkPattern.exec(text)) !== null) {
    addSearchItem(results, seenUrls, markdownMatch[2] ?? "", markdownMatch[1] ?? "", getNearbyLine(text, markdownMatch.index));
  }

  const plainUrlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = plainUrlPattern.exec(text)) !== null) {
    addSearchItem(results, seenUrls, urlMatch[0] ?? "", "", getNearbyLine(text, urlMatch.index));
  }

  return results;
}

function parseStructuredSearchItemsFromText(text: string): WebSearchItem[] {
  const results: WebSearchItem[] = [];
  const seenUrls = new Set<string>();
  const blocks = text.split(/\n-{3,}\n/g);

  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const rawUrl = block.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]?.trim() ?? "";
    const url = normalizePublicUrl(rawUrl);
    if (!url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    results.push({
      title: title || hostnameTitle(url),
      url,
      snippet: truncate(extractStructuredSnippet(block), 400)
    });
  }

  return results;
}

function extractStructuredSnippet(block: string): string {
  const lines = block.split(/\r?\n/);
  const highlightsIndex = lines.findIndex((line) => line.trim() === "Highlights:");
  const snippetLines = (highlightsIndex >= 0 ? lines.slice(highlightsIndex + 1) : lines)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || line === "[...]") {
        return false;
      }

      return !/^(Title|URL|Published|Author|Highlights):/.test(line);
    });

  return collapseWhitespace(snippetLines.join(" "));
}

function addSearchItem(
  results: WebSearchItem[],
  seenUrls: Set<string>,
  rawUrl: string,
  rawTitle: string,
  rawSnippet: string
): void {
  const url = normalizePublicUrl(rawUrl);
  if (!url || seenUrls.has(url)) {
    return;
  }

  seenUrls.add(url);
  const title = collapseWhitespace(rawTitle) || hostnameTitle(url);
  const snippet = collapseWhitespace(rawSnippet.replace(rawUrl, "").replace(rawTitle, ""));
  results.push({
    title,
    url,
    snippet: truncate(snippet, 400)
  });
}

function getNearbyLine(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const nextLine = text.indexOf("\n", index);
  const lineEnd = nextLine === -1 ? text.length : nextLine;
  return text.slice(lineStart, lineEnd);
}

function hostnameTitle(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
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
    return normalizePublicUrl(target);
  } catch {
    return null;
  }
}

function normalizePublicUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function deduplicateResults(results: WebSearchItem[]): WebSearchItem[] {
  const seenUrls = new Set<string>();
  const deduped: WebSearchItem[] = [];

  for (const result of results) {
    const normalizedUrl = normalizePublicUrl(result.url);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    deduped.push({
      ...result,
      url: normalizedUrl
    });
  }

  return deduped;
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

  const normalizedAllowed = normalizeDomainList(allowedDomains);
  const normalizedBlocked = normalizeDomainList(blockedDomains);

  if (normalizedAllowed.length > 0 && !normalizedAllowed.some((domain) => isDomainMatch(hostname, domain))) {
    return false;
  }

  if (normalizedBlocked.length > 0 && normalizedBlocked.some((domain) => isDomainMatch(hostname, domain))) {
    return false;
  }

  return true;
}

function normalizeDomainList(domains: string[] | undefined): string[] {
  return (domains ?? [])
    .map(normalizeDomain)
    .filter((domain): domain is string => Boolean(domain));
}

function normalizeDomain(rawDomain: string): string | null {
  const trimmed = rawDomain.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const hostname = parsed.hostname.replace(/^\*\./, "").replace(/^\./, "");
    return hostname || null;
  } catch {
    const domain = trimmed
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .replace(/^\*\./, "")
      .replace(/^\./, "");
    return domain && !/\s/.test(domain) ? domain : null;
  }
}

function formatDomainList(domains: string[] | undefined): string {
  const normalized = normalizeDomainList(domains);
  return normalized.length > 0 ? normalized.join(", ") : "(none)";
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



function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
