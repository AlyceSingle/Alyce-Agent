const WINDOWS_POWERSHELL_UTF8_PREAMBLE_LINES = [
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [Console]::OutputEncoding",
  "chcp 65001 > $null"
];

export function wrapPowerShellCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }

  return [...WINDOWS_POWERSHELL_UTF8_PREAMBLE_LINES, command].join("\n");
}

export function toOutputBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

export function decodeCapturedOutput(chunks: readonly Buffer[]): string {
  if (chunks.length === 0) {
    return "";
  }

  const buffer = Buffer.concat(chunks);
  if (process.platform !== "win32") {
    return buffer.toString("utf8");
  }

  return decodeWindowsOutputBuffer(buffer);
}

export function sanitizePowerShellErrorOutput(output: string): string {
  if (process.platform !== "win32" || output.length === 0) {
    return output;
  }

  const normalizedOutput = output.replace(/\r\n/g, "\n");
  const normalizedPrefix = `${WINDOWS_POWERSHELL_UTF8_PREAMBLE_LINES.join("\n")}\n`;
  if (!normalizedOutput.startsWith(normalizedPrefix)) {
    return output;
  }

  const stripped = normalizedOutput.slice(normalizedPrefix.length);
  return output.includes("\r\n") ? stripped.replace(/\n/g, "\r\n") : stripped;
}

function decodeWindowsOutputBuffer(buffer: Buffer): string {
  if (looksLikeUtf16Le(buffer)) {
    return new TextDecoder("utf-16le").decode(buffer);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gb18030").decode(buffer);
  }
}

function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return true;
  }

  if (buffer.length < 4 || buffer.length % 2 !== 0) {
    return false;
  }

  let zeroByteCount = 0;
  let oddIndexZeroByteCount = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) {
      continue;
    }

    zeroByteCount += 1;
    if (index % 2 === 1) {
      oddIndexZeroByteCount += 1;
    }
  }

  return zeroByteCount >= buffer.length / 4 && oddIndexZeroByteCount * 5 >= zeroByteCount * 4;
}
