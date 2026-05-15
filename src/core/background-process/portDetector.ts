const URL_PATTERN = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[^\]\s]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\/[^\s"'<>)]*)?/giu;
const BARE_LOCALHOST_PATTERN = /\b(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0):(\d{2,5})\b/giu;
const PORT_TEXT_PATTERN = /\b(?:port|listen(?:ing)? on|server on|started on)\D{0,24}(\d{2,5})\b/giu;
const DEV_SERVER_READY_PATTERNS = [
  /\bready\s+in\s+\d+(?:\.\d+)?\s*(?:ms|s)\b/iu,
  /\bready\b.{0,40}\bstarted\s+server\s+on\b/iu,
  /\bstarted\s+server\s+on\b/iu,
  /\bserver\s+(?:running|listening|started)\s+(?:at|on)\b/iu,
  /\blistening\s+on\b/iu,
  /\bcompiled\s+successfully\b/iu
] as const;
const PORT_IN_USE_PATTERN = /\bport\s+(\d{2,5})\s+(?:is\s+)?(?:already\s+)?in\s+use\b/giu;
const ALREADY_RUNNING_ON_PORT_PATTERN = /\balready\s+running\s+on\s+port\s+(\d{2,5})\b/giu;
const EADDRINUSE_LINE_PATTERN = /\b(?:EADDRINUSE|address\s+already\s+in\s+use)\b/iu;
const PORT_ON_LINE_PATTERN = /(?:port\s+|:)(\d{2,5})\b/giu;

export interface PortConflictDetection {
  ports: number[];
  message: string;
}

export function detectUrls(text: string): string[] {
  const urls: string[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = normalizeUrl(match[0]);
    if (url) {
      urls.push(url);
    }
  }

  for (const match of text.matchAll(BARE_LOCALHOST_PATTERN)) {
    const host = match[1];
    const port = match[2];
    if (!host || !port || !isValidPort(Number(port))) {
      continue;
    }

    urls.push(`http://${host}:${port}/`);
  }

  return unique(urls);
}

export function detectPorts(text: string): number[] {
  const ports: number[] = [];

  for (const url of detectUrls(text)) {
    try {
      const parsed = new URL(url);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
      if (isValidPort(port)) {
        ports.push(port);
      }
    } catch {
      // Ignore malformed URLs; URL detection is best-effort.
    }
  }

  for (const match of text.matchAll(PORT_TEXT_PATTERN)) {
    const port = Number(match[1]);
    if (isValidPort(port)) {
      ports.push(port);
    }
  }

  for (const conflict of detectPortConflicts(text)) {
    ports.push(...conflict.ports);
  }

  return unique(ports).sort((left, right) => left - right);
}

export function detectDevServerReadiness(text: string): string | null {
  for (const pattern of DEV_SERVER_READY_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[0]) {
      return normalizeWhitespace(match[0]);
    }
  }

  return null;
}

export function detectPortConflicts(text: string): PortConflictDetection[] {
  const conflicts: PortConflictDetection[] = [];

  for (const match of text.matchAll(PORT_IN_USE_PATTERN)) {
    const port = Number(match[1]);
    if (isValidPort(port)) {
      conflicts.push({
        ports: [port],
        message: `Port ${port} is already in use.`
      });
    }
  }

  for (const match of text.matchAll(ALREADY_RUNNING_ON_PORT_PATTERN)) {
    const port = Number(match[1]);
    if (isValidPort(port)) {
      conflicts.push({
        ports: [port],
        message: `Port ${port} is already in use.`
      });
    }
  }

  for (const line of text.split(/\r?\n/u)) {
    if (!EADDRINUSE_LINE_PATTERN.test(line)) {
      continue;
    }

    const ports = extractPortsFromLine(line);
    conflicts.push({
      ports,
      message: ports.length > 0
        ? `Port ${ports.join(", ")} is already in use (EADDRINUSE).`
        : "Address already in use (EADDRINUSE)."
    });
  }

  return uniqueConflicts(conflicts);
}

function normalizeUrl(candidate: string): string | null {
  const trimmed = candidate.replace(/[.,;:]+$/u, "");
  try {
    const parsed = new URL(trimmed);
    if (!parsed.pathname) {
      parsed.pathname = "/";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function extractPortsFromLine(line: string): number[] {
  const ports: number[] = [];
  for (const match of line.matchAll(PORT_ON_LINE_PATTERN)) {
    const port = Number(match[1]);
    if (isValidPort(port)) {
      ports.push(port);
    }
  }

  return unique(ports);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueConflicts(conflicts: readonly PortConflictDetection[]): PortConflictDetection[] {
  const seen = new Set<string>();
  const uniqueValues: PortConflictDetection[] = [];
  for (const conflict of conflicts) {
    const key = `${conflict.message}\0${conflict.ports.join(",")}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueValues.push(conflict);
  }

  return uniqueValues;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
