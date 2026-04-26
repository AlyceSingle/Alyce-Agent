import { lookup } from "node:dns/promises";
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
  await assertPublicFetchUrl(normalizedUrl);
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

    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertPublicFetchUrl(currentUrl);

      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent": "AlyceAgent/0.1"
        }
      });

      if (!isRedirectResponse(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      if (redirectCount >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new Error(`WebFetch stopped after ${MAX_REDIRECTS} redirects`);
      }

      await response.body?.cancel();
      currentUrl = normalizeUrl(new URL(location, currentUrl).toString());
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

async function assertPublicFetchUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`WebFetch requires a public hostname: ${parsed.hostname}`);
  }

  if (isIP(hostname) !== 0) {
    assertPublicIpAddress(hostname, parsed.hostname);
    return;
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
