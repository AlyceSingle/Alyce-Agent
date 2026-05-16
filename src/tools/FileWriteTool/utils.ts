import {
  createStructuredPatch,
  type StructuredPatchHunk
} from "../internal/structuredPatch.js";

export type { StructuredPatchHunk };

export function getPatchForWrite(options: {
  filePath: string;
  originalFile: string;
  nextFile: string;
}): StructuredPatchHunk[] {
  return createStructuredPatch({
    filePath: options.filePath,
    oldContent: options.originalFile,
    newContent: options.nextFile,
    includeFileHeader: true
  });
}
