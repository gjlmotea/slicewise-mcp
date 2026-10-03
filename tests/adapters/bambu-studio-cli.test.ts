import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readProjectFilamentColours } from '../../src/adapters/bambu-studio-cli.js';
import { buildStoredZip } from '../fixtures/zip-builder.js';

const workDir = mkdtempSync(join(tmpdir(), 'bambu-cli-test-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function write(name: string, content: Buffer | string): string {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
}

describe('readProjectFilamentColours', () => {
  it('讀出 Bambu 專案 3MF 的各格耗材顏色', () => {
    const path = write(
      'project.3mf',
      buildStoredZip([
        { name: '3D/3dmodel.model', content: '<model/>' },
        {
          name: 'Metadata/project_settings.config',
          content: JSON.stringify({ filament_colour: ['#FFFFFF', '#E91D2D'], layer_height: '0.2' }),
        },
      ]),
    );
    expect(readProjectFilamentColours(path)).toEqual(['#FFFFFF', '#E91D2D']);
  });

  it('沒有專案設定的 3MF、STL 或讀不到的檔案回傳 undefined', () => {
    const bare = write('bare.3mf', buildStoredZip([{ name: '3D/3dmodel.model', content: '<model/>' }]));
    expect(readProjectFilamentColours(bare)).toBeUndefined();
    expect(readProjectFilamentColours(write('model.stl', 'solid cube\nendsolid cube\n'))).toBeUndefined();
    expect(readProjectFilamentColours(join(workDir, 'missing.3mf'))).toBeUndefined();
  });

  it('顏色欄位形狀不對時不採信', () => {
    const path = write(
      'odd.3mf',
      buildStoredZip([
        { name: 'Metadata/project_settings.config', content: JSON.stringify({ filament_colour: '#FFFFFF' }) },
      ]),
    );
    expect(readProjectFilamentColours(path)).toBeUndefined();
  });
});
