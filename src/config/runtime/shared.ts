import { promises as fs } from "node:fs";
import path from "node:path";

export type SourceLayer<T extends object, Source extends string> = {
  source: Source;
  values: Partial<T>;
};

export function mergeLayers<T extends object, Source extends string>(
  layers: Array<SourceLayer<T, Source>>
): Partial<T> {
  // 顺序即优先级，后面的 layer 会覆盖前面的同名字段。
  return Object.assign({}, ...layers.map((layer) => layer.values));
}

export function buildSourceMap<T extends object, Source extends string>(
  effective: T,
  layers: Array<SourceLayer<T, Source>>,
  defaultSource: Source
): Record<keyof T, Source> {
  const sources = {} as Record<keyof T, Source>;

  for (const key of Object.keys(effective) as Array<keyof T>) {
    let source = defaultSource;
    // 这里故意与 mergeLayers 使用同一顺序，便于准确追踪"最终值来自哪一层"。
    for (const layer of layers) {
      if (layer.values[key] !== undefined) {
        source = layer.source;
      }
    }

    sources[key] = source;
  }

  return sources;
}

export async function resolvePromptTextFromCli(options: {
  argv: string[];
  directFlag: string;
  fileFlag: string;
  label: string;
}): Promise<string | undefined> {
  const directValue = getArgValue(options.argv, options.directFlag);
  const fileValue = getArgValue(options.argv, options.fileFlag);

  if (directValue && fileValue) {
    throw new Error(`Cannot use ${options.directFlag} and ${options.fileFlag} at the same time.`);
  }

  if (fileValue) {
    const absolutePath = path.resolve(fileValue);
    try {
      return await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${options.label} file: ${absolutePath}. ${message}`);
    }
  }

  return directValue;
}

export function getArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

export function getArgValues(argv: string[], flag: string): string[] | undefined {
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) {
      continue;
    }

    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }

    values.push(candidate);
  }

  return values.length > 0 ? values : undefined;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(parsed));
}

export function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(1, Math.trunc(parsed));
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseOptionalBoolean(value);
  return parsed ?? fallback;
}

export function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}

export function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

export function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value!));
}

export function clampBoundedInt(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(value!)));
}

export function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function parsePathListFromEnv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}

export function compactObject<T extends object>(value: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as Partial<T>;
}

export function configRelativePath(workspaceRoot: string, absolutePath: string) {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }

  return relative;
}

export function compactObjectExcept<T extends object>(
  value: Partial<T>,
  keepKeys: ReadonlySet<keyof T>
): Partial<T> {
  return Object.fromEntries(
    (Object.entries(value) as Array<[keyof T, unknown]>).filter(
      ([entryKey, entryValue]) => entryValue !== undefined || keepKeys.has(entryKey)
    )
  ) as Partial<T>;
}
