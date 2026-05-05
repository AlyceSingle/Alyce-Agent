import { promises as fs } from "node:fs";

export type TextFileEncoding = "utf8" | "utf16le";
export type LineEndingType = "LF" | "CRLF";
export type WriteLineEndingMode = LineEndingType | "preserve";

export interface TextFileMetadata {
  content: string;
  encoding: TextFileEncoding;
  lineEndings: LineEndingType;
  hasBom: boolean;
}

export async function readTextFileWithMetadata(filePath: string): Promise<TextFileMetadata> {
  const buffer = await fs.readFile(filePath);
  return decodeTextBuffer(buffer);
}

export async function readTextFileBytesWithMetadata(
  filePath: string
): Promise<TextFileMetadata & { rawBytes: Buffer }> {
  const rawBytes = await fs.readFile(filePath);
  return {
    ...decodeTextBuffer(rawBytes),
    rawBytes
  };
}

export async function detectTextFileEncoding(filePath: string): Promise<TextFileEncoding> {
  const handle = await fs.open(filePath, "r");
  try {
    const sample = Buffer.alloc(4);
    const result = await handle.read(sample, 0, sample.length, 0);
    return detectBufferEncoding(sample.subarray(0, result.bytesRead)).encoding;
  } finally {
    await handle.close();
  }
}

export async function writeTextFileWithMetadata(
  filePath: string,
  content: string,
  options: {
    encoding?: TextFileEncoding;
    lineEndings?: WriteLineEndingMode;
    hasBom?: boolean;
  } = {}
) {
  await fs.writeFile(filePath, encodeTextFileContent(content, options));
}

export function encodeTextFileContent(
  content: string,
  options: {
    encoding?: TextFileEncoding;
    lineEndings?: WriteLineEndingMode;
    hasBom?: boolean;
  } = {}
) {
  const encoding = options.encoding ?? "utf8";
  const normalizedContent = normalizeLineEndingsForWrite(content, options.lineEndings ?? "preserve");
  const encoded = Buffer.from(
    options.hasBom ? stripBom(normalizedContent) : normalizedContent,
    encoding
  );
  return options.hasBom ? Buffer.concat([getBom(encoding), encoded]) : encoded;
}

export function normalizeTextContent(content: string) {
  return stripBom(content).replace(/\r\n/g, "\n");
}

export function countTextLines(content: string) {
  if (content.length === 0) {
    return 0;
  }

  const lines = normalizeTextContent(content).split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }

  return lines.length;
}

function decodeTextBuffer(buffer: Buffer): TextFileMetadata {
  const detected = detectBufferEncoding(buffer);
  const contentBuffer = detected.bomBytes > 0 ? buffer.subarray(detected.bomBytes) : buffer;
  const rawContent = contentBuffer.toString(detected.encoding);
  const content = normalizeTextContent(rawContent);

  return {
    content,
    encoding: detected.encoding,
    lineEndings: detectLineEndings(rawContent),
    hasBom: detected.bomBytes > 0
  };
}

function detectBufferEncoding(buffer: Buffer): { encoding: TextFileEncoding; bomBytes: number } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: "utf16le", bomBytes: 2 };
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: "utf8", bomBytes: 3 };
  }

  return { encoding: "utf8", bomBytes: 0 };
}

function detectLineEndings(content: string): LineEndingType {
  let crlfCount = 0;
  let lfCount = 0;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") {
      continue;
    }

    if (index > 0 && content[index - 1] === "\r") {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }

  return crlfCount > lfCount ? "CRLF" : "LF";
}

function normalizeLineEndingsForWrite(content: string, mode: WriteLineEndingMode) {
  if (mode === "preserve" || mode === "LF") {
    return mode === "LF" ? content.replace(/\r\n/g, "\n") : content;
  }

  return content.replace(/\r\n/g, "\n").split("\n").join("\r\n");
}

function stripBom(content: string) {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function getBom(encoding: TextFileEncoding) {
  return encoding === "utf16le"
    ? Buffer.from([0xff, 0xfe])
    : Buffer.from([0xef, 0xbb, 0xbf]);
}
