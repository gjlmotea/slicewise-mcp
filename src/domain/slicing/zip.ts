import { inflateRawSync } from 'node:zlib';

/**
 * 最小 ZIP 讀取器。
 *
 * 3MF 就是一個 ZIP 容器。我們只需要「按名稱取出單一項目」這一件事，
 * 不需要寫入、不需要串流、不需要加密支援，所以不引入第三方依賴。
 *
 * 只支援 stored(0) 與 deflate(8) 兩種壓縮方式 —— BambuStudio 的輸出只用這兩種。
 * 遇到其他方式一律明確拋錯，不做靜默略過。
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** EOCD 後面可以跟最多 65535 bytes 的註解。 */
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

/** 讀 central directory，回傳所有項目的索引。 */
export function readZipDirectory(buffer: Buffer): readonly ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) {
      throw new ZipFormatError('central directory 被截斷');
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError(`central directory 第 ${index} 項簽章不正確`);
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

/** 取出單一項目的內容。找不到回傳 undefined，讓呼叫端決定是不是致命。 */
export function readZipEntry(buffer: Buffer, entryName: string): Buffer | undefined {
  const entry = readZipDirectory(buffer).find((candidate) => candidate.name === entryName);
  if (entry === undefined) return undefined;
  return extractEntry(buffer, entry);
}

export function extractEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`${entry.name} 的 local header 簽章不正確`);
  }

  // local header 的 name／extra 長度可能與 central directory 不同，必須重讀。
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > buffer.length) {
    throw new ZipFormatError(`${entry.name} 的資料超出檔案長度`);
  }

  const raw = buffer.subarray(dataStart, dataEnd);

  switch (entry.compressionMethod) {
    case 0:
      return Buffer.from(raw);
    case 8:
      return inflateRawSync(raw);
    default:
      throw new ZipFormatError(
        `${entry.name} 使用不支援的壓縮方式 ${entry.compressionMethod}；只支援 stored 與 deflate`,
      );
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_SIZE) {
    throw new ZipFormatError('檔案太小，不是合法的 ZIP 容器');
  }

  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipFormatError('找不到 end of central directory；檔案不是 ZIP 或已損毀');
}
