import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reader.
 *
 * A 3MF is just a ZIP container. All we need is to extract a single entry by name: no
 * writing, no streaming, no encryption support, so no third-party dependency is pulled in.
 *
 * Only the stored(0) and deflate(8) compression methods are supported, the only two
 * BambuStudio's output uses. Any other method throws an explicit error rather than being
 * silently skipped.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** The EOCD may be followed by a comment of up to 65535 bytes. */
const MAX_COMMENT = 0xffff;

export type ZipEntry = {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
};

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

/** Read the central directory and return the index of all entries. */
export function readZipDirectory(buffer: Buffer): readonly ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) {
      throw new ZipFormatError('central directory is truncated');
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError(`central directory entry ${index} has an invalid signature`);
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Extract a single entry's content. Returns undefined if not found, letting the caller decide whether that is fatal. */
export function readZipEntry(buffer: Buffer, entryName: string): Buffer | undefined {
  const entry = readZipDirectory(buffer).find((candidate) => candidate.name === entryName);
  if (entry === undefined) return undefined;
  return extractEntry(buffer, entry);
}

export function extractEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`${entry.name} has an invalid local header signature`);
  }

  // The local header's name / extra lengths may differ from the central directory's, so they must be re-read.
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > buffer.length) {
    throw new ZipFormatError(`${entry.name} data extends past the end of the file`);
  }

  const raw = buffer.subarray(dataStart, dataEnd);

  switch (entry.compressionMethod) {
    case 0:
      return Buffer.from(raw);
    case 8:
      return inflateRawSync(raw);
    default:
      throw new ZipFormatError(
        `${entry.name} uses unsupported compression method ${entry.compressionMethod}; only stored and deflate are supported`,
      );
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_SIZE) {
    throw new ZipFormatError('File is too small to be a valid ZIP container');
  }

  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipFormatError('End of central directory not found; the file is not a ZIP or is corrupted');
}
