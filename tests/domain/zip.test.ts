import { describe, expect, it } from 'vitest';

import { readZipDirectory, readZipEntry, ZipFormatError } from '../../src/domain/slicing/zip.js';
import { buildStoredZip } from '../fixtures/zip-builder.js';

const ARCHIVE = buildStoredZip([
  { name: 'Metadata/project_settings.config', content: '{"layer_height":"0.28"}' },
  { name: 'Metadata/plate_1.gcode', content: '; total layer number: 72\n' },
]);

describe('readZipDirectory', () => {
  it('lists all entries', () => {
    const entries = readZipDirectory(ARCHIVE);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Metadata/project_settings.config',
      'Metadata/plate_1.gcode',
    ]);
  });

  it('throws an explicit error when the input is not a ZIP', () => {
    expect(() => readZipDirectory(Buffer.from('not a zip at all'))).toThrow(ZipFormatError);
  });

  it('throws an explicit error when the file is too small', () => {
    expect(() => readZipDirectory(Buffer.alloc(4))).toThrow(/too small/);
  });
});

describe('readZipEntry', () => {
  it('extracts the content of a stored (uncompressed) entry', () => {
    const content = readZipEntry(ARCHIVE, 'Metadata/project_settings.config');
    expect(content?.toString('utf8')).toBe('{"layer_height":"0.28"}');
  });

  it('returns undefined rather than throwing when the entry is missing', () => {
    expect(readZipEntry(ARCHIVE, 'Metadata/missing.config')).toBeUndefined();
  });
});
