import { splitLines } from "../FileEditTool/utils.js";

export type StructuredPatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export function getPatchForWrite(options: {
  filePath: string;
  originalFile: string;
  nextFile: string;
}): StructuredPatchHunk[] {
  const originalLines = splitLines(options.originalFile);
  const nextLines = splitLines(options.nextFile);

  if (options.originalFile === options.nextFile) {
    return [
      {
        oldStart: 1,
        oldLines: originalLines.length,
        newStart: 1,
        newLines: nextLines.length,
        lines: [
          `--- ${options.filePath}`,
          `+++ ${options.filePath}`,
          `@@ -${formatHunkRange(1, originalLines.length)} +${formatHunkRange(1, nextLines.length)} @@`,
          ...nextLines.map((line) => ` ${line}`)
        ]
      }
    ];
  }

  return [
    {
      oldStart: 1,
      oldLines: originalLines.length,
      newStart: 1,
      newLines: nextLines.length,
      lines: [
        `--- ${options.filePath}`,
        `+++ ${options.filePath}`,
        `@@ -${formatHunkRange(1, originalLines.length)} +${formatHunkRange(1, nextLines.length)} @@`,
        ...originalLines.map((line) => `-${line}`),
        ...nextLines.map((line) => `+${line}`)
      ]
    }
  ];
}

function formatHunkRange(start: number, count: number) {
  return `${start},${count}`;
}
