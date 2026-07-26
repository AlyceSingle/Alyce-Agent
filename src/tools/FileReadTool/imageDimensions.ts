import { promises as fs } from "node:fs";

export async function readImageDimensions(absolutePath: string) {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return parseImageDimensions(buffer.subarray(0, result.bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function parseImageDimensions(buffer: Buffer) {
  return (
    parsePngDimensions(buffer) ??
    parseGifDimensions(buffer) ??
    parseJpegDimensions(buffer) ??
    parseBmpDimensions(buffer) ??
    parseIcoDimensions(buffer) ??
    parseWebpDimensions(buffer)
  );
}

function parsePngDimensions(buffer: Buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return undefined;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function parseGifDimensions(buffer: Buffer) {
  if (buffer.length < 10) {
    return undefined;
  }

  const header = buffer.subarray(0, 6).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") {
    return undefined;
  }

  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8)
  };
}

function parseBmpDimensions(buffer: Buffer) {
  if (buffer.length < 26 || buffer.subarray(0, 2).toString("ascii") !== "BM") {
    return undefined;
  }

  return {
    width: Math.abs(buffer.readInt32LE(18)),
    height: Math.abs(buffer.readInt32LE(22))
  };
}

function parseIcoDimensions(buffer: Buffer) {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    return undefined;
  }

  return {
    width: buffer[6] === 0 ? 256 : buffer[6],
    height: buffer[7] === 0 ? 256 : buffer[7]
  };
}

function parseWebpDimensions(buffer: Buffer) {
  if (buffer.length < 30) {
    return undefined;
  }

  if (
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return undefined;
  }

  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }

  if (chunkType === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  return undefined;
}

function parseJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      return undefined;
    }

    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5)
      };
    }

    offset += 2 + segmentLength;
  }

  return undefined;
}
