export const DEFAULT_MAX_SIZE_BYTES = 256 * 1024;
export const MAX_LINES_TO_READ = 2000;

export interface FileReadingLimits {
  maxSizeBytes: number;
  maxLines: number;
}

export function getDefaultFileReadingLimits(): FileReadingLimits {
  return {
    maxSizeBytes: parsePositiveInt(process.env.AGENT_FILE_READ_MAX_BYTES, DEFAULT_MAX_SIZE_BYTES),
    maxLines: parsePositiveInt(process.env.AGENT_FILE_READ_MAX_LINES, MAX_LINES_TO_READ)
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(parsed));
}
