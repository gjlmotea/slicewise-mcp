import { crc32, deflateRawSync } from 'node:zlib';

/**
 * 最小 ZIP 寫入器。
 *
 * 3MF 是 ZIP 容器，所以要產生 3MF 就得能寫 ZIP。與 `zip.ts` 的讀取器一樣不引入
 * 第三方依賴：只需要「把幾個小的文字檔打包起來」這一件事。
 *
 * 每個項目個別決定要不要壓縮 —— 壓完反而變大時就用 stored。小的 XML 通常壓得很好，
 * 但已經壓過的內容（例如嵌入的 PNG）壓了只會變大。
 */

export type ZipInputEntry = {
  readonly name: string;
  readonly content: string | Buffer;
};

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const VERSION = 20;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export function buildZip(entries: readonly ZipInputEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORED;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time — 固定值讓輸出可重現
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localChunks.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION, 4); // version made by
    central.writeUInt16LE(VERSION, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const localBlock = Buffer.concat(localChunks);
  const centralBlock = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBlock, centralBlock, eocd]);
}
