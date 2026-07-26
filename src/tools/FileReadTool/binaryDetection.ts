import { promises as fs } from "node:fs";
import path from "node:path";
import type { TextFileEncoding } from "../internal/textFileIO.js";

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".class",
  ".dat",
  ".dll",
  ".doc",
  ".docx",
  ".exe",
  ".gz",
  ".jar",
  ".lib",
  ".obj",
  ".o",
  ".odt",
  ".ods",
  ".odp",
  ".ppt",
  ".pptx",
  ".pyc",
  ".pyo",
  ".so",
  ".tar",
  ".war",
  ".wasm",
  ".xls",
  ".xlsx",
  ".zip"
]);

export async function isBinaryFile(
  absolutePath: string,
  fileSize: number,
  textEncoding: TextFileEncoding
): Promise<boolean> {
  const extension = path.extname(absolutePath).toLowerCase();
  if (KNOWN_BINARY_EXTENSIONS.has(extension)) {
    return true;
  }

  if (textEncoding === "utf16le") {
    return false;
  }

  if (fileSize === 0) {
    return false;
  }

  const handle = await fs.open(absolutePath, "r");
  try {
    const sampleSize = Math.min(4096, fileSize);
    const bytes = Buffer.alloc(sampleSize);
    const result = await handle.read(bytes, 0, sampleSize, 0);
    if (result.bytesRead === 0) {
      return false;
    }

    let nonPrintableCount = 0;
    for (let index = 0; index < result.bytesRead; index += 1) {
      if (bytes[index] === 0) {
        return true;
      }

      if (bytes[index] < 9 || (bytes[index] > 13 && bytes[index] < 32)) {
        nonPrintableCount += 1;
      }
    }

    return nonPrintableCount / result.bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}
