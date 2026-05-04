import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import {
  isTurnInterruptedError,
  throwIfAborted,
  toTurnInterruptedError
} from "../../core/abort.js";
import { truncate } from "../internal/values.js";
import type { ToolExecutionContext } from "../types.js";
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from "./prompt.js";

const DEFAULT_MAX_CHARS = 8_000;
const MAX_MAX_CHARS = 40_000;
const MAX_REDIRECTS = 10;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const DEFAULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONTACT_URL = "https://www.npmjs.com/package/alyce";
const BROWSER_COMPATIBLE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = `AlyceAgent/0.1 (+${DEFAULT_CONTACT_URL})`;

type WebFetchFormat = "text" | "markdown" | "html";

interface PublicFetchTarget {
  url: string;
  address: string;
  family: 4 | 6;
}

interface PinnedFetchResponse {
  url: string;
  status: number;
  statusText: string;
  headers: {
    get: (name: string) => string | null;
  };
  bytes: number;
  text: () => Promise<string>;
}

interface PinnedFetchOptions {
  format: WebFetchFormat;
  maxBytes: number;
  userAgent: string;
}

interface CachedFetchResponse {
  response: PinnedFetchResponse;
  expiresAt: number;
  bytes: number;
}

type RedirectApproval = (fromUrl: string, toUrl: string) => Promise<boolean>;

const FETCH_RESPONSE_CACHE = new Map<string, CachedFetchResponse>();

type PinnedLookupAddress = {
  address: string;
  family: 4 | 6;
};

type PinnedLookupOptions = {
  all?: boolean;
};

type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | PinnedLookupAddress[],
  family?: 4 | 6
) => void;

export const WebFetchInputSchema = z
  .object({
    url: z.string().url().describe("Public URL to fetch"),
    prompt: z.string().optional().describe("Optional extraction hint"),
    format: z
      .enum(["text", "markdown", "html"])
      .optional()
      .describe("Return format for HTML responses. Defaults to markdown."),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(MAX_MAX_CHARS)
      .optional()
      .describe("Maximum number of characters to return"),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_MAX_RESPONSE_BYTES)
      .optional()
      .describe("Maximum response bytes to download")
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
  format: WebFetchFormat;
  content: string;
  truncated: boolean;
  promptApplied: boolean;
  warnings: string[];
  cacheHit: boolean;
}

export async function executeWebFetchTool(
  input: z.infer<typeof WebFetchInputSchema>,
  context: ToolExecutionContext
): Promise<WebFetchResult> {
  throwIfAborted(context.abortSignal);

  const normalizedUrl = normalizeUrl(input.url);
  const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
  const format = input.format ?? "markdown";
  const maxBytes = input.max_bytes ?? getDefaultMaxResponseBytes();
  const timeoutMs = Math.max(1, context.commandTimeoutMs);

  const approved = await context.requestApproval({
    kind: "web",
    toolName: WEB_FETCH_TOOL_NAME,
    title: "Fetch web content",
    summary: normalizedUrl,
    details: [
      `Format: ${format}`,
      `Max chars: ${maxChars}`,
      `Max bytes: ${maxBytes}`,
      `Prompt filter: ${input.prompt ? "yes" : "no"}`
    ]
  });
  if (!approved) {
    throw new Error("User rejected WebFetch tool request");
  }

  throwIfAborted(context.abortSignal);

  const { response, cacheHit } = await fetchWithTimeout(
    normalizedUrl,
    timeoutMs,
    format,
    maxBytes,
    (fromUrl, toUrl) => requestRedirectApproval(context, fromUrl, toUrl, format, maxChars, maxBytes),
    context.abortSignal
  );
  const rawBody = await response.text();
  const contentType = response.headers.get("content-type") ?? "unknown";
  const warnings = buildResponseWarnings(response);

  const formattedContent = normalizeBody(rawBody, contentType, format, response.url || normalizedUrl);
  const focusedText = input.prompt ? applyPromptHeuristic(formattedContent, input.prompt) : formattedContent;

  return {
    url: normalizedUrl,
    finalUrl: response.url || normalizedUrl,
    status: response.status,
    statusText: response.statusText,
    contentType,
    bytes: response.bytes,
    format,
    content: truncate(focusedText, maxChars),
    truncated: focusedText.length > maxChars,
    promptApplied: Boolean(input.prompt),
    warnings,
    cacheHit
  };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  format: WebFetchFormat,
  maxBytes: number,
  requestRedirectApproval: RedirectApproval,
  parentSignal?: AbortSignal
): Promise<{ response: PinnedFetchResponse; cacheHit: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const handleAbort = () => controller.abort(parentSignal?.reason);

  try {
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener("abort", handleAbort, { once: true });
    }

    let currentUrl = url;
    let cacheHit = false;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const preferredUserAgent = getPreferredUserAgent(currentUrl);
      const cacheKey = buildFetchCacheKey(currentUrl, format, maxBytes, preferredUserAgent);
      const cachedResponse = getCachedFetchResponse(cacheKey);
      if (cachedResponse) {
        cacheHit = true;
        if (!isRedirectResponse(cachedResponse.status)) {
          return { response: cachedResponse, cacheHit };
        }
      }

      const target = await resolvePublicFetchTarget(currentUrl);
      let responseUserAgent = preferredUserAgent;
      let response = await requestPinnedUrl(target, controller.signal, {
        format,
        maxBytes,
        userAgent: responseUserAgent
      });

      if (shouldRetryWithHonestUserAgent(response)) {
        responseUserAgent = getHonestUserAgent();
        const honestCacheKey = buildFetchCacheKey(currentUrl, format, maxBytes, responseUserAgent);
        const cachedHonestResponse = getCachedFetchResponse(honestCacheKey);
        if (cachedHonestResponse && !isRedirectResponse(cachedHonestResponse.status)) {
          return { response: cachedHonestResponse, cacheHit: true };
        }

        response = await requestPinnedUrl(target, controller.signal, {
          format,
          maxBytes,
          userAgent: responseUserAgent
        });
      }

      if (!isRedirectResponse(response.status)) {
        if (isCacheableFetchResponse(response)) {
          setCachedFetchResponse(buildFetchCacheKey(currentUrl, format, maxBytes, responseUserAgent), response);
        }

        return { response, cacheHit };
      }

      const location = response.headers.get("location");
      if (!location) {
        return { response, cacheHit };
      }

      if (redirectCount >= MAX_REDIRECTS) {
        throw new Error(`WebFetch stopped after ${MAX_REDIRECTS} redirects`);
      }

      const nextUrl = normalizeUrl(new URL(location, currentUrl).toString());
      if (requiresCrossOriginRedirectApproval(currentUrl, nextUrl)) {
        const approved = await requestRedirectApproval(currentUrl, nextUrl);
        if (!approved) {
          throw new Error(`User rejected WebFetch redirect from ${currentUrl} to ${nextUrl}`);
        }

        throwIfAborted(parentSignal);
      }

      currentUrl = nextUrl;
    }

    throw new Error(`WebFetch stopped after ${MAX_REDIRECTS} redirects`);
  } catch (error) {
    // 用户主动中断必须继续向上冒泡，不能被误判成超时。
    if (isTurnInterruptedError(error, parentSignal)) {
      throw toTurnInterruptedError(error, parentSignal);
    }

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

  if (parsed.protocol !== "https:") {
    throw new Error(`WebFetch only supports public http(s) URLs: ${rawUrl}`);
  }

  return parsed.toString();
}

function requestRedirectApproval(
  context: ToolExecutionContext,
  fromUrl: string,
  toUrl: string,
  format: WebFetchFormat,
  maxChars: number,
  maxBytes: number
): Promise<boolean> {
  return context.requestApproval({
    kind: "web",
    toolName: WEB_FETCH_TOOL_NAME,
    title: "Follow cross-origin redirect",
    summary: toUrl,
    details: [
      `From: ${fromUrl}`,
      `To: ${toUrl}`,
      `Format: ${format}`,
      `Max chars: ${maxChars}`,
      `Max bytes: ${maxBytes}`
    ]
  });
}

function requiresCrossOriginRedirectApproval(fromUrl: string, toUrl: string): boolean {
  try {
    const from = new URL(fromUrl);
    const to = new URL(toUrl);
    return from.origin.toLowerCase() !== to.origin.toLowerCase();
  } catch {
    return true;
  }
}

async function resolvePublicFetchTarget(url: string): Promise<PublicFetchTarget> {
  const parsed = new URL(url);
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`WebFetch requires a public hostname: ${parsed.hostname}`);
  }

  const directIpVersion = isIP(hostname);
  if (directIpVersion !== 0) {
    assertPublicIpAddress(hostname, parsed.hostname);
    return {
      url,
      address: hostname,
      family: toPublicIpVersion(directIpVersion)
    };
  }

  let addresses;
  try {
    addresses = await lookup(hostname, {
      all: true,
      verbatim: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`WebFetch could not resolve ${parsed.hostname}: ${message}`);
  }

  if (addresses.length === 0) {
    throw new Error(`WebFetch could not resolve ${parsed.hostname}`);
  }

  for (const address of addresses) {
    assertPublicIpAddress(address.address, parsed.hostname);
  }

  const selectedAddress = addresses[0]!;
  return {
    url,
    address: selectedAddress.address,
    family: toPublicIpVersion(selectedAddress.family)
  };
}

function requestPinnedUrl(
  target: PublicFetchTarget,
  signal: AbortSignal,
  options: PinnedFetchOptions
): Promise<PinnedFetchResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target.url);
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };
    const request = httpsRequest(
      parsed,
      {
        signal,
        headers: createRequestHeaders(options),
        lookup: createPinnedLookup(target)
      },
      (response) => {
        const chunks: Buffer[] = [];
        const contentLength = response.headers["content-length"];
        if (contentLength && Number.parseInt(contentLength, 10) > options.maxBytes) {
          const error = new Error(`WebFetch response is too large (content-length exceeds ${options.maxBytes} bytes)`);
          response.destroy(error);
          request.destroy(error);
          rejectOnce(error);
          return;
        }

        let receivedBytes = 0;

        response.on("error", rejectOnce);

        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > options.maxBytes) {
            const error = new Error(`WebFetch response exceeded ${options.maxBytes} bytes`);
            response.destroy(error);
            request.destroy(error);
            rejectOnce(error);
            return;
          }

          chunks.push(buffer);
        });

        response.on("end", () => {
          if (settled) {
            return;
          }

          const bodyBuffer = Buffer.concat(chunks);
          settled = true;
          resolve({
            url: target.url,
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers: createHeaderLookup(response.headers),
            bytes: bodyBuffer.byteLength,
            text: async () => bodyBuffer.toString("utf8")
          });
        });
      }
    );

    request.on("error", rejectOnce);
    request.end();
  });
}

function createRequestHeaders(options: PinnedFetchOptions): Record<string, string> {
  return {
    accept: getAcceptHeader(options.format),
    "accept-language": getAcceptLanguage(),
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent": options.userAgent
  };
}

function getAcceptHeader(format: WebFetchFormat): string {
  switch (format) {
    case "html":
      return "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
    case "text":
      return "text/plain;q=1.0,text/markdown;q=0.9,text/html;q=0.8,*/*;q=0.5";
    case "markdown":
      return "text/markdown;q=1.0,text/x-markdown;q=0.9,text/html;q=0.8,text/plain;q=0.7,*/*;q=0.5";
  }
}

function getBrowserCompatibleUserAgent(): string {
  return process.env.ALYCE_WEB_FETCH_USER_AGENT?.trim() || BROWSER_COMPATIBLE_USER_AGENT;
}

function getHonestUserAgent(): string {
  return process.env.ALYCE_WEB_FETCH_HONEST_USER_AGENT?.trim() || HONEST_USER_AGENT;
}

function getPreferredUserAgent(url: string): string {
  if (requiresTransparentContactUserAgent(url)) {
    return getHonestUserAgent();
  }

  return getBrowserCompatibleUserAgent();
}

function requiresTransparentContactUserAgent(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === "wikipedia.org" ||
      hostname.endsWith(".wikipedia.org") ||
      hostname === "wikimedia.org" ||
      hostname.endsWith(".wikimedia.org") ||
      hostname === "mediawiki.org" ||
      hostname.endsWith(".mediawiki.org")
    );
  } catch {
    return false;
  }
}

function getAcceptLanguage(): string {
  return process.env.ALYCE_WEB_FETCH_ACCEPT_LANGUAGE?.trim() || "en-US,en;q=0.9";
}

function getDefaultMaxResponseBytes(): number {
  const rawValue = process.env.ALYCE_WEB_FETCH_MAX_BYTES ?? process.env.WEB_FETCH_MAX_BYTES;
  if (!rawValue?.trim()) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_MAX_RESPONSE_BYTES) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }

  return parsed;
}

function buildFetchCacheKey(url: string, format: WebFetchFormat, maxBytes: number, userAgent: string): string {
  return JSON.stringify({
    url,
    format,
    maxBytes,
    acceptLanguage: getAcceptLanguage(),
    userAgent
  });
}

function getCachedFetchResponse(cacheKey: string): PinnedFetchResponse | null {
  const maxCacheBytes = getFetchCacheMaxBytes();
  if (maxCacheBytes <= 0) {
    FETCH_RESPONSE_CACHE.clear();
    return null;
  }

  pruneFetchResponseCache(maxCacheBytes);
  const now = Date.now();
  const cached = FETCH_RESPONSE_CACHE.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    FETCH_RESPONSE_CACHE.delete(cacheKey);
    return null;
  }

  FETCH_RESPONSE_CACHE.delete(cacheKey);
  FETCH_RESPONSE_CACHE.set(cacheKey, cached);
  return clonePinnedFetchResponse(cached.response);
}

function setCachedFetchResponse(cacheKey: string, response: PinnedFetchResponse): void {
  const ttlMs = getFetchCacheTtlMs();
  if (ttlMs <= 0) {
    return;
  }

  const maxCacheBytes = getFetchCacheMaxBytes();
  if (maxCacheBytes <= 0 || response.bytes > maxCacheBytes) {
    return;
  }

  FETCH_RESPONSE_CACHE.set(cacheKey, {
    response: clonePinnedFetchResponse(response),
    expiresAt: Date.now() + ttlMs,
    bytes: response.bytes
  });
  pruneFetchResponseCache(maxCacheBytes);
}

function pruneFetchResponseCache(maxCacheBytes = getFetchCacheMaxBytes()): void {
  const now = Date.now();
  for (const [key, value] of FETCH_RESPONSE_CACHE) {
    if (value.expiresAt <= now) {
      FETCH_RESPONSE_CACHE.delete(key);
    }
  }

  while (FETCH_RESPONSE_CACHE.size > MAX_CACHE_ENTRIES || getFetchResponseCacheBytes() > maxCacheBytes) {
    const oldestKey = FETCH_RESPONSE_CACHE.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }

    FETCH_RESPONSE_CACHE.delete(oldestKey);
  }
}

function getFetchResponseCacheBytes(): number {
  let totalBytes = 0;
  for (const value of FETCH_RESPONSE_CACHE.values()) {
    totalBytes += value.bytes;
  }

  return totalBytes;
}

function clonePinnedFetchResponse(response: PinnedFetchResponse): PinnedFetchResponse {
  return {
    ...response,
    headers: response.headers,
    text: response.text
  };
}

function isCacheableFetchResponse(response: PinnedFetchResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function getFetchCacheTtlMs(): number {
  const rawValue = process.env.ALYCE_WEB_FETCH_CACHE_TTL_MS ?? process.env.WEB_FETCH_CACHE_TTL_MS;
  if (!rawValue?.trim()) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CACHE_TTL_MS;
  }

  return parsed;
}

function getFetchCacheMaxBytes(): number {
  const rawValue = process.env.ALYCE_WEB_FETCH_CACHE_MAX_BYTES ?? process.env.WEB_FETCH_CACHE_MAX_BYTES;
  if (!rawValue?.trim()) {
    return DEFAULT_CACHE_MAX_BYTES;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CACHE_MAX_BYTES;
  }

  return parsed;
}

function shouldRetryWithHonestUserAgent(response: PinnedFetchResponse): boolean {
  return (
    response.status === 403 &&
    (response.headers.get("cf-mitigated") === "challenge" ||
      response.statusText.toLowerCase().includes("too many reqs"))
  );
}

function createPinnedLookup(target: PublicFetchTarget) {
  return (
    _hostname: string,
    options: PinnedLookupOptions | PinnedLookupCallback,
    callback?: PinnedLookupCallback
  ) => {
    const done = typeof options === "function" ? options : callback;
    if (!done) {
      return;
    }

    if (typeof options !== "function" && options.all === true) {
      done(null, [{ address: target.address, family: target.family }]);
      return;
    }

    done(null, target.address, target.family);
  };
}

function createHeaderLookup(headers: IncomingHttpHeaders) {
  return {
    get: (name: string) => {
      const value = headers[name.toLowerCase()];
      if (Array.isArray(value)) {
        return value.join(", ");
      }

      return value ?? null;
    }
  };
}

function toPublicIpVersion(ipVersion: number): 4 | 6 {
  if (ipVersion === 4 || ipVersion === 6) {
    return ipVersion;
  }

  throw new Error(`Invalid IP version: ${ipVersion}`);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function assertPublicIpAddress(address: string, hostname: string): void {
  const normalizedAddress = normalizeHostname(address);
  const mappedIpv4 = getIpv4MappedAddress(normalizedAddress);
  if (mappedIpv4) {
    assertPublicIpAddress(mappedIpv4, hostname);
    return;
  }

  const ipVersion = isIP(normalizedAddress);
  if (ipVersion === 4 && isPrivateIpv4(normalizedAddress)) {
    throw new Error(`WebFetch blocked non-public address for ${hostname}: ${normalizedAddress}`);
  }

  if (ipVersion === 6 && isPrivateIpv6(normalizedAddress)) {
    throw new Error(`WebFetch blocked non-public address for ${hostname}: ${normalizedAddress}`);
  }

  if (ipVersion === 0) {
    throw new Error(`WebFetch resolved an invalid address for ${hostname}: ${address}`);
  }
}

function getIpv4MappedAddress(address: string): string | null {
  return address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1] ?? null;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  if (address === "::" || address === "::1") {
    return true;
  }

  const firstHextet = Number.parseInt(address.split(":")[0] || "0", 16);
  if (!Number.isFinite(firstHextet)) {
    return true;
  }

  return (
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00
  );
}

function isRedirectResponse(status: number): boolean {
  return status >= 300 && status < 400;
}

function buildResponseWarnings(response: PinnedFetchResponse): string[] {
  const warnings: string[] = [];
  const cfMitigated = response.headers.get("cf-mitigated");
  const proxyError = response.headers.get("x-proxy-error");

  if (response.status === 401) {
    warnings.push("HTTP 401: authentication is required; WebFetch does not use browser cookies or private credentials.");
  }

  if (response.status === 403) {
    warnings.push("HTTP 403: access denied or anti-bot challenge detected.");
  }

  if (response.status === 429) {
    warnings.push("HTTP 429: target site rate-limited the request.");
  }

  if (cfMitigated) {
    warnings.push(`Cloudflare mitigation header detected: cf-mitigated=${cfMitigated}.`);
  }

  if (proxyError) {
    warnings.push(`Proxy error header detected: x-proxy-error=${proxyError}.`);
  }

  return warnings;
}

function normalizeBody(rawBody: string, contentType: string, format: WebFetchFormat, baseUrl: string): string {
  const lowerContentType = contentType.toLowerCase();
  if (!lowerContentType.includes("text/html")) {
    return rawBody;
  }

  switch (format) {
    case "html":
      return rawBody;
    case "markdown":
      return htmlToMarkdown(rawBody, baseUrl);
    case "text":
      return htmlToText(rawBody);
  }
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "\n")
      .replace(/<!--([\s\S]*?)-->/g, "\n")
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, content: string) => {
        return `\n${"#".repeat(Number(level))} ${collapseWhitespace(stripTags(content))}\n`;
      })
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, content: string) => {
        const label = collapseWhitespace(stripTags(content));
        const normalizedHref = normalizeLinkHref(href, baseUrl);
        return label ? `[${label}](${normalizedHref})` : normalizedHref;
      })
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_match, content: string) => {
        return `\n\`\`\`\n${stripTags(content).trim()}\n\`\`\`\n`;
      })
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, content: string) => {
        return `\n\`\`\`\n${stripTags(content).trim()}\n\`\`\`\n`;
      })
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, content: string) => {
        const code = collapseWhitespace(stripTags(content));
        return code ? `\`${code}\`` : "";
      })
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/(?:div|section|article|header|footer|nav|main|ul|ol|table|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n-\s*(?=\n)/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function normalizeLinkHref(rawHref: string, baseUrl: string): string {
  try {
    return new URL(rawHref, baseUrl).toString();
  } catch {
    return rawHref;
  }
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

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
