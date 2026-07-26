import { asNullableNumber, asRecord, asString } from "../../core/util/unknown.js";
import type { getDefaultFileReadingLimits } from "./limits.js";
import type { NotebookCellReadResult, NotebookReadResult } from "./results.js";

export function createNotebookResult(
  filePath: string,
  notebookText: string,
  startCell: number,
  limit: number,
  limits: ReturnType<typeof getDefaultFileReadingLimits>
): NotebookReadResult {
  let parsedNotebook: unknown;
  try {
    parsedNotebook = JSON.parse(notebookText) as unknown;
  } catch {
    throw new Error("Notebook file is not valid JSON");
  }

  const notebookRecord = asRecord(parsedNotebook);
  if (!notebookRecord) {
    throw new Error("Notebook file does not contain a valid top-level object");
  }

  const cells = Array.isArray(notebookRecord.cells) ? notebookRecord.cells : [];
  const startIndex = startCell - 1;
  const selectedCells = cells.slice(startIndex, startIndex + limit);
  const summarizedCells = selectedCells.map((cell, index) =>
    summarizeNotebookCell(cell, startIndex + index + 1, limits)
  );
  const truncated = startIndex + summarizedCells.length < cells.length;

  return {
    type: "notebook",
    file: {
      filePath,
      summary: buildNotebookSummary(notebookRecord, cells),
      cells: summarizedCells,
      numCells: summarizedCells.length,
      startCell,
      totalCells: cells.length,
      truncated,
      nextOffset: truncated ? startCell + summarizedCells.length : undefined,
      notice: buildNotebookNotice(cells.length, startCell, summarizedCells.length)
    }
  };
}

function buildNotebookSummary(notebook: Record<string, unknown>, cells: unknown[]) {
  let codeCells = 0;
  let markdownCells = 0;
  let rawCells = 0;

  for (const cell of cells) {
    const record = asRecord(cell);
    const cellType = asString(record?.cell_type);
    if (cellType === "code") {
      codeCells += 1;
    } else if (cellType === "markdown") {
      markdownCells += 1;
    } else if (cellType === "raw") {
      rawCells += 1;
    }
  }

  const metadata = asRecord(notebook.metadata);
  const languageInfo = asRecord(metadata?.language_info);
  const kernelSpec = asRecord(metadata?.kernelspec);
  const language = asString(languageInfo?.name);
  const kernel = asString(kernelSpec?.display_name);
  const summaryParts = [
    `Notebook with ${cells.length} cells`,
    `${codeCells} code`,
    `${markdownCells} markdown`,
    `${rawCells} raw`
  ];

  if (language) {
    summaryParts.push(`language: ${language}`);
  }

  if (kernel) {
    summaryParts.push(`kernel: ${kernel}`);
  }

  return summaryParts.join(", ");
}

function buildNotebookNotice(totalCells: number, startCell: number, numCells: number) {
  if (totalCells === 0) {
    return "Notebook has no cells.";
  }

  if (numCells === 0) {
    return `offset ${startCell} is beyond notebook length (${totalCells} cells).`;
  }

  return undefined;
}

function summarizeNotebookCell(
  cell: unknown,
  index: number,
  limits: ReturnType<typeof getDefaultFileReadingLimits>
): NotebookCellReadResult {
  const record = asRecord(cell);
  const cellType = asString(record?.cell_type) ?? "unknown";
  const source = truncateNotebookText(readNotebookMultilineValue(record?.source), limits.maxNotebookCellChars);
  const executionCount = asNullableNumber(record?.execution_count);
  const rawOutputs = Array.isArray(record?.outputs) ? record.outputs : [];
  const outputs = rawOutputs
    .slice(0, limits.maxNotebookOutputsPerCell)
    .map((output) => truncateNotebookText(renderNotebookOutput(output), limits.maxNotebookOutputChars))
    .filter((output) => output.length > 0);

  if (rawOutputs.length > limits.maxNotebookOutputsPerCell) {
    outputs.push(`... ${rawOutputs.length - limits.maxNotebookOutputsPerCell} more outputs omitted`);
  }

  return {
    index,
    cellType,
    source,
    ...(cellType === "code" ? { executionCount } : {}),
    ...(outputs.length > 0 ? { outputs } : {})
  };
}

function readNotebookMultilineValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join("");
  }

  return "";
}

function renderNotebookOutput(output: unknown): string {
  const record = asRecord(output);
  if (!record) {
    return "";
  }

  const outputType = asString(record.output_type);
  if (outputType === "stream") {
    return readNotebookMultilineValue(record.text);
  }

  if (outputType === "error") {
    const traceback = Array.isArray(record.traceback)
      ? record.traceback.filter((line): line is string => typeof line === "string").join("\n")
      : "";
    const ename = asString(record.ename);
    const evalue = asString(record.evalue);
    return [ename, evalue].filter(Boolean).join(": ") + (traceback ? `\n${traceback}` : "");
  }

  if (outputType === "display_data" || outputType === "execute_result") {
    const data = asRecord(record.data);
    if (!data) {
      return "";
    }

    const plainText = readNotebookMultilineValue(data["text/plain"]);
    if (plainText) {
      return plainText;
    }

    const keys = Object.keys(data);
    if (keys.length > 0) {
      return `[rich output: ${keys.join(", ")}]`;
    }
  }

  if ("text" in record) {
    return readNotebookMultilineValue(record.text);
  }

  return truncateNotebookText(formatUnknownValue(output), 400);
}

function truncateNotebookText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...<truncated ${value.length - maxChars} chars>`;
}

function formatUnknownValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
