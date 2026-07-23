import type {
  TerminalUiMessageBlock,
  TerminalUiMessageBlockTone,
  TerminalUiToolReadResult
} from "../../state/types.js";
import {
  asBoolean,
  asNumber,
  asNumberArray,
  asRecord,
  asRecordArray,
  asString,
  asStringArray,
  capitalizeWord,
  createBlock,
  formatBytes
} from "./common.js";

// Read 工具结果展示。

export function toReadResult(value: unknown): TerminalUiToolReadResult | null {
  const record = asRecord(value);
  const type = asString(record?.type);
  if (!record || !type) {
    return null;
  }

  switch (type) {
    case "text": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const startLine = asNumber(file?.startLine);
      const numLines = asNumber(file?.numLines);
      const totalLines = asNumber(file?.totalLines);
      const truncated = asBoolean(file?.truncated);

      if (
        !filePath ||
        startLine === undefined ||
        numLines === undefined ||
        totalLines === undefined ||
        truncated === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        startLine,
        numLines,
        totalLines,
        truncated,
        nextOffset: asNumber(file?.nextOffset)
      };
    }
    case "directory": {
      const directory = asRecord(record.directory);
      const directoryPath = asString(directory?.directoryPath);
      const startEntry = asNumber(directory?.startEntry);
      const numEntries = asNumber(directory?.numEntries);
      const totalEntries = asNumber(directory?.totalEntries);
      const truncated = asBoolean(directory?.truncated);

      if (
        !directoryPath ||
        startEntry === undefined ||
        numEntries === undefined ||
        totalEntries === undefined ||
        truncated === undefined
      ) {
        return null;
      }

      return {
        type,
        directoryPath,
        startEntry,
        numEntries,
        totalEntries,
        truncated,
        nextOffset: asNumber(directory?.nextOffset)
      };
    }
    case "notebook": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const summary = asString(file?.summary);
      const startCell = asNumber(file?.startCell);
      const numCells = asNumber(file?.numCells);
      const totalCells = asNumber(file?.totalCells);
      const truncated = asBoolean(file?.truncated);

      if (
        !filePath ||
        !summary ||
        startCell === undefined ||
        numCells === undefined ||
        totalCells === undefined ||
        truncated === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        summary,
        startCell,
        numCells,
        totalCells,
        truncated,
        nextOffset: asNumber(file?.nextOffset)
      };
    }
    case "image":
    case "pdf":
    case "binary": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const mediaType = asString(file?.mediaType);
      const sizeBytes = asNumber(file?.sizeBytes);
      const visualReadSupported = asBoolean(file?.visualReadSupported);
      const dimensions = toImageDimensions(file?.dimensions);

      if (
        !filePath ||
        !mediaType ||
        sizeBytes === undefined ||
        visualReadSupported === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        mediaType,
        sizeBytes,
        visualReadSupported,
        ...(dimensions ? { dimensions } : {})
      };
    }
    case "file_unchanged": {
      const file = asRecord(record.file);
      const filePath = asString(file?.filePath);
      const message = asString(file?.message);
      const previousKind = asString(file?.previousKind);
      const offset = asNumber(file?.offset);

      if (
        !filePath ||
        !message ||
        (previousKind !== "text" && previousKind !== "notebook") ||
        offset === undefined
      ) {
        return null;
      }

      return {
        type,
        filePath,
        message,
        previousKind,
        offset,
        limit: asNumber(file?.limit)
      };
    }
    default:
      return null;
  }
}

export function toImageDimensions(value: unknown) {
  const record = asRecord(value);
  const width = asNumber(record?.width);
  const height = asNumber(record?.height);
  if (!record || width === undefined || height === undefined) {
    return undefined;
  }

  return { width, height };
}

export function buildReadResultBlocks(
  read: TerminalUiToolReadResult,
  structuredResult: unknown
): TerminalUiMessageBlock[] {
  switch (read.type) {
    case "text": {
      const content = asString(asRecord(asRecord(structuredResult)?.file)?.content) ?? "(empty)";
      return [
        createBlock(content, {
          label: "Content",
          tone: "success",
          style: "code"
        })
      ];
    }
    case "directory": {
      const directory = asRecord(asRecord(structuredResult)?.directory);
      const entries = Array.isArray(directory?.entries)
        ? directory.entries.filter((entry): entry is string => typeof entry === "string")
        : [];
      const notice = asString(directory?.notice);
      const blocks: TerminalUiMessageBlock[] = [
        createBlock(entries.length > 0 ? entries.join("\n") : "(empty directory)", {
          label: "Entries",
          tone: "success",
          style: "code"
        })
      ];

      if (notice) {
        blocks.push(createBlock(notice, { label: "Note", tone: "warning" }));
      }

      return blocks;
    }
    case "notebook": {
      const file = asRecord(asRecord(structuredResult)?.file);
      const summary = asString(file?.summary) ?? read.summary;
      const notice = asString(file?.notice);
      const blocks: TerminalUiMessageBlock[] = [
        createBlock(summary, { label: "Summary", tone: "info" }),
        createBlock(formatNotebookCellsForDisplay(file?.cells), {
          label: "Cells",
          tone: "success",
          style: "code"
        })
      ];

      if (notice) {
        blocks.push(createBlock(notice, { label: "Note", tone: "warning" }));
      }

      return blocks;
    }
    case "image":
    case "pdf":
    case "binary": {
      const file = asRecord(asRecord(structuredResult)?.file);
      const message = asString(file?.message) ?? "Asset read completed.";
      const details = [
        `Path: ${read.filePath}`,
        `Type: ${capitalizeWord(read.type)}`,
        `Media: ${read.mediaType}`,
        `Size: ${formatBytes(read.sizeBytes)}`,
        ...(read.dimensions ? [`Dimensions: ${read.dimensions.width} x ${read.dimensions.height}`] : []),
        `Visual read: ${read.visualReadSupported ? "supported" : "not supported"}`
      ].join("\n");

      return [
        createBlock(message, {
          label: "Status",
          tone: read.visualReadSupported ? "success" : "warning"
        }),
        createBlock(details, { label: "Details", style: "code" })
      ];
    }
    case "file_unchanged": {
      const range = read.limit === undefined
        ? `offset ${read.offset}`
        : `offset ${read.offset}, limit ${read.limit}`;
      return [
        createBlock(read.message, { label: "Status", tone: "info" }),
        createBlock(
          [`Path: ${read.filePath}`, `Previous read type: ${read.previousKind}`, `Range: ${range}`].join("\n"),
          { label: "Details", style: "code" }
        )
      ];
    }
  }
}

export function buildReadMetadata(read: TerminalUiToolReadResult) {
  switch (read.type) {
    case "text": {
      const endLine = read.numLines > 0 ? read.startLine + read.numLines - 1 : read.startLine;
      return [
        "Text",
        `Lines ${read.startLine}-${endLine}/${read.totalLines}`,
        ...(read.truncated && read.nextOffset !== undefined ? [`Next: ${read.nextOffset}`] : [])
      ];
    }
    case "directory": {
      const endEntry = read.numEntries > 0 ? read.startEntry + read.numEntries - 1 : read.startEntry;
      return [
        "Directory",
        `Entries ${read.startEntry}-${endEntry}/${read.totalEntries}`,
        ...(read.truncated && read.nextOffset !== undefined ? [`Next: ${read.nextOffset}`] : [])
      ];
    }
    case "notebook": {
      const endCell = read.numCells > 0 ? read.startCell + read.numCells - 1 : read.startCell;
      return [
        "Notebook",
        `Cells ${read.startCell}-${endCell}/${read.totalCells}`,
        ...(read.truncated && read.nextOffset !== undefined ? [`Next: ${read.nextOffset}`] : [])
      ];
    }
    case "image":
    case "pdf":
    case "binary":
      return [
        capitalizeWord(read.type),
        read.mediaType,
        formatBytes(read.sizeBytes),
        ...(read.dimensions ? [`${read.dimensions.width}x${read.dimensions.height}`] : []),
        read.visualReadSupported ? "Model attached" : "Metadata only"
      ];
    case "file_unchanged":
      return [
        "Unchanged",
        capitalizeWord(read.previousKind),
        read.limit === undefined ? `Offset ${read.offset}` : `Offset ${read.offset}, limit ${read.limit}`
      ];
  }
}

export function formatNotebookCellsForDisplay(value: unknown) {
  if (!Array.isArray(value)) {
    return "(no notebook cells)";
  }

  const renderedCells = value.flatMap((cell) => {
    const record = asRecord(cell);
    const index = asNumber(record?.index);
    const cellType = asString(record?.cellType);
    const source = asString(record?.source);

    if (index === undefined || !cellType) {
      return [];
    }

    const heading =
      cellType === "code"
        ? `[${index}] code${formatNotebookExecutionSuffix(record?.executionCount)}`
        : `[${index}] ${cellType}`;
    const lines = [heading, source && source.length > 0 ? source : "(empty)"];
    const outputs = Array.isArray(record?.outputs)
      ? record.outputs.filter((output): output is string => typeof output === "string")
      : [];

    if (outputs.length > 0) {
      lines.push("", "[outputs]", outputs.join("\n\n"));
    }

    return [lines.join("\n")];
  });

  return renderedCells.length > 0 ? renderedCells.join("\n\n") : "(no notebook cells)";
}

export function formatNotebookExecutionSuffix(value: unknown) {
  if (value === null) {
    return " (exec=null)";
  }

  const executionCount = asNumber(value);
  return executionCount === undefined ? "" : ` (exec=${executionCount})`;
}
