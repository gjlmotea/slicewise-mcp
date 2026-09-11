import { describe, expect, it } from 'vitest';

import { readZipDirectory, readZipEntry, ZipFormatError } from '../../src/domain/slicing/zip.js';
import { buildStoredZip } from '../fixtures/zip-builder.js';

const ARCHIVE = buildStoredZip([
  { name: 'Metadata/project_settings.config', content: '{"layer_height":"0.28"}' },
  { name: 'Metadata/plate_1.gcode', content: '; total layer number: 72\n' },
]);

describe('readZipDirectory', () => {
  it('列出所有項目', () => {
    const entries = readZipDirectory(ARCHIVE);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Metadata/project_settings.config',
      'Metadata/plate_1.gcode',
    ]);
  });

  it('不是 ZIP 時明確報錯', () => {
    expect(() => readZipDirectory(Buffer.from('not a zip at all'))).toThrow(ZipFormatError);
  });

  it('檔案太小時明確報錯', () => {
    expect(() => readZipDirectory(Buffer.alloc(4))).toThrow(/太小/);
  });
});

describe('readZipEntry', () => {
  it('取出未壓縮項目的內容', () => {
    const content = readZipEntry(ARCHIVE, 'Metadata/project_settings.config');
    expect(content?.toString('utf8')).toBe('{"layer_height":"0.28"}');
  });

  it('找不到項目時回 undefined 而不是拋錯', () => {
    expect(readZipEntry(ARCHIVE, 'Metadata/missing.config')).toBeUndefined();
  });
});
