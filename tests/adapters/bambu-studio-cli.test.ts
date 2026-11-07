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
  it('reads the per-slot filament colours of a Bambu project 3MF', () => {
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

  it('returns undefined for a 3MF without project settings, an STL, or an unreadable file', () => {
    const bare = write('bare.3mf', buildStoredZip([{ name: '3D/3dmodel.model', content: '<model/>' }]));
    expect(readProjectFilamentColours(bare)).toBeUndefined();
    expect(readProjectFilamentColours(write('model.stl', 'solid cube\nendsolid cube\n'))).toBeUndefined();
    expect(readProjectFilamentColours(join(workDir, 'missing.3mf'))).toBeUndefined();
  });

  it('does not trust a colour field with the wrong shape', () => {
    const path = write(
      'odd.3mf',
      buildStoredZip([
        { name: 'Metadata/project_settings.config', content: JSON.stringify({ filament_colour: '#FFFFFF' }) },
      ]),
    );
    expect(readProjectFilamentColours(path)).toBeUndefined();
  });
});
