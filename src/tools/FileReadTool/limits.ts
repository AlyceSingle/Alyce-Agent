export const DEFAULT_MAX_SIZE_BYTES = 256 * 1024;
export const DEFAULT_MAX_NOTEBOOK_SIZE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_TEXT_RESULT_BYTES = 200 * 1024;
export const DEFAULT_DIRECTORY_ENTRIES_TO_READ = 200;
export const MAX_DIRECTORY_ENTRIES_TO_READ = 2000;
export const DEFAULT_NOTEBOOK_CELLS_TO_READ = 50;
export const MAX_NOTEBOOK_CELLS_TO_READ = 200;
export const DEFAULT_NOTEBOOK_OUTPUTS_PER_CELL = 3;
export const DEFAULT_NOTEBOOK_CELL_CHARS = 4000;
export const DEFAULT_NOTEBOOK_OUTPUT_CHARS = 2000;
export const DEFAULT_MAX_LINE_CHARS = 2000;
export const MAX_LINES_TO_READ = 6000;

export interface FileReadingLimits {
  maxSizeBytes: number;
  maxTextResultBytes: number;
  maxLines: number;
  maxLineChars: number;
  defaultDirectoryEntries: number;
  maxDirectoryEntries: number;
  maxNotebookSizeBytes: number;
  defaultNotebookCells: number;
  maxNotebookCells: number;
  maxNotebookOutputsPerCell: number;
  maxNotebookCellChars: number;
  maxNotebookOutputChars: number;
}

export function getDefaultFileReadingLimits(): FileReadingLimits {
  const maxLines = parsePositiveInt(process.env.AGENT_FILE_READ_MAX_LINES, MAX_LINES_TO_READ);
  const maxDirectoryEntries = Math.min(maxLines, MAX_DIRECTORY_ENTRIES_TO_READ);
  return {
    maxSizeBytes: parsePositiveInt(process.env.AGENT_FILE_READ_MAX_BYTES, DEFAULT_MAX_SIZE_BYTES),
    maxTextResultBytes: DEFAULT_MAX_TEXT_RESULT_BYTES,
    maxLines,
    maxLineChars: DEFAULT_MAX_LINE_CHARS,
    defaultDirectoryEntries: Math.min(DEFAULT_DIRECTORY_ENTRIES_TO_READ, maxDirectoryEntries),
    maxDirectoryEntries,
    maxNotebookSizeBytes: DEFAULT_MAX_NOTEBOOK_SIZE_BYTES,
    defaultNotebookCells: DEFAULT_NOTEBOOK_CELLS_TO_READ,
    maxNotebookCells: MAX_NOTEBOOK_CELLS_TO_READ,
    maxNotebookOutputsPerCell: DEFAULT_NOTEBOOK_OUTPUTS_PER_CELL,
    maxNotebookCellChars: DEFAULT_NOTEBOOK_CELL_CHARS,
    maxNotebookOutputChars: DEFAULT_NOTEBOOK_OUTPUT_CHARS
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
