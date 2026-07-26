import { createRequire } from "node:module";
import path from "node:path";
import { runNativeCommandWithTimeout } from "./nativeCommandRunner.js";

export interface RipgrepInvocation {
  kind: "system" | "bundled";
  argvPrefix: readonly string[];
}

export interface DetectRipgrepOptions {
  probeSystemRg?: () => Promise<boolean>;
  resolveBundledScript?: () => string | null;
  execPath?: string;
}

const SYSTEM_RG_PROBE_TIMEOUT_MS = 5_000;
const SYSTEM_RG_PROBE_MAX_OUTPUT_BYTES = 4_096;

let cachedInvocation: Promise<RipgrepInvocation> | null = null;

export function resolveRipgrepInvocation(): Promise<RipgrepInvocation> {
  cachedInvocation ??= detectRipgrepInvocation();
  return cachedInvocation;
}

export function resetRipgrepInvocationCacheForTests(): void {
  cachedInvocation = null;
}

export async function detectRipgrepInvocation(
  options: DetectRipgrepOptions = {}
): Promise<RipgrepInvocation> {
  const probeSystemRg = options.probeSystemRg ?? probeSystemRgOnPath;
  if (await probeSystemRg()) {
    return { kind: "system", argvPrefix: ["rg"] };
  }

  const resolveBundledScript = options.resolveBundledScript ?? resolveBundledRgScript;
  const bundledScript = resolveBundledScript();
  if (bundledScript) {
    return {
      kind: "bundled",
      argvPrefix: [options.execPath ?? process.execPath, bundledScript]
    };
  }

  // Neither found: keep spawning plain "rg" so callers surface the ENOENT error.
  return { kind: "system", argvPrefix: ["rg"] };
}

async function probeSystemRgOnPath(): Promise<boolean> {
  const result = await runNativeCommandWithTimeout(["rg", "--version"], {
    timeoutMs: SYSTEM_RG_PROBE_TIMEOUT_MS,
    maxOutputBytes: SYSTEM_RG_PROBE_MAX_OUTPUT_BYTES
  });

  return !result.error && result.exitCode === 0;
}

export function resolveBundledRgScript(): string | null {
  try {
    const requireFromHere = createRequire(import.meta.url);
    // Resolves to <package>/lib/index.mjs; rg.mjs beside it is the CLI wrapper
    // that runs the WASI build and exits with rg's exit code.
    const packageEntry = requireFromHere.resolve("ripgrep");
    return path.join(path.dirname(packageEntry), "rg.mjs");
  } catch {
    return null;
  }
}
