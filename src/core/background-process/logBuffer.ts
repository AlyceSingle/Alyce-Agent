export interface LogBufferOptions {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

export class LogBuffer {
  private readonly maxBytes: number;
  private value = "";

  constructor(options: LogBufferOptions = {}) {
    this.maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES));
  }

  append(text: string): string {
    if (!text) {
      return this.value;
    }

    this.value += text;
    this.trimToMaxBytes();
    return this.value;
  }

  getText(): string {
    return this.value;
  }

  tailLines(lineCount: number): string {
    const normalizedCount = Math.max(0, Math.trunc(lineCount));
    if (normalizedCount === 0 || this.value.length === 0) {
      return "";
    }

    const hasTrailingNewline = /\r?\n$/u.test(this.value);
    const lines = this.value.split(/\r?\n/u);
    if (hasTrailingNewline) {
      lines.pop();
    }

    const tail = lines.slice(-normalizedCount).join("\n");
    return hasTrailingNewline && tail ? `${tail}\n` : tail;
  }

  private trimToMaxBytes() {
    let byteLength = Buffer.byteLength(this.value, "utf8");
    while (byteLength > this.maxBytes && this.value.length > 0) {
      const excessBytes = byteLength - this.maxBytes;
      const charsToRemove = Math.max(1, Math.min(this.value.length, Math.ceil(excessBytes / 4)));
      this.value = this.value.slice(charsToRemove);
      byteLength = Buffer.byteLength(this.value, "utf8");
    }
  }
}

export function tailLines(text: string, lineCount: number): string {
  const buffer = new LogBuffer({ maxBytes: Math.max(1, Buffer.byteLength(text, "utf8")) });
  buffer.append(text);
  return buffer.tailLines(lineCount);
}
