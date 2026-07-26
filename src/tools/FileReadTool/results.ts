export interface FileTextReadResult {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
    truncated: boolean;
    nextOffset?: number;
    notice?: string;
  };
}

export interface DirectoryReadResult {
  type: "directory";
  directory: {
    directoryPath: string;
    entries: string[];
    startEntry: number;
    numEntries: number;
    totalEntries: number;
    truncated: boolean;
    nextOffset?: number;
    notice?: string;
  };
}

export interface NotebookCellReadResult {
  index: number;
  cellType: string;
  source: string;
  executionCount?: number | null;
  outputs?: string[];
}

export interface NotebookReadResult {
  type: "notebook";
  file: {
    filePath: string;
    summary: string;
    cells: NotebookCellReadResult[];
    numCells: number;
    startCell: number;
    totalCells: number;
    truncated: boolean;
    nextOffset?: number;
    notice?: string;
  };
}

export interface AssetReadResult {
  type: "image" | "pdf" | "binary";
  file: {
    filePath: string;
    mediaType: string;
    sizeBytes: number;
    visualReadSupported: boolean;
    message: string;
    dimensions?: {
      width: number;
      height: number;
    };
  };
}

export interface FileUnchangedReadResult {
  type: "file_unchanged";
  file: {
    filePath: string;
    message: string;
    previousKind: "text" | "notebook";
    offset: number;
    limit?: number;
  };
}

export type FileReadResult =
  | FileTextReadResult
  | DirectoryReadResult
  | NotebookReadResult
  | AssetReadResult
  | FileUnchangedReadResult;
