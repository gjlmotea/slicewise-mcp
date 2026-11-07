import { describe, expect, it } from 'vitest';

import { buildPrimitive } from '../../src/domain/model/primitives.js';
import {
  buildBambuProject,
  isPartSubtype,
  PART_SUBTYPES,
  readProjectStructure,
  ThreeMfBuildError,
  trianglesToIndexedMesh,
} from '../../src/domain/model/threemf.js';
import { readZipDirectory, readZipEntry } from '../../src/domain/slicing/zip.js';
import { boxTriangles } from '../fixtures/geometry.js';

const CUBE = buildPrimitive({ kind: 'box', size: { x: 20, y: 20, z: 20 } });
const HOLE = buildPrimitive({ kind: 'cylinder', diameter: 6, height: 30 });

function project(parts: Parameters<typeof buildBambuProject>[0]['parts']) {
  return buildBambuProject({ objectName: 'test', parts });
}

const BODY = { name: 'body', subtype: 'normal_part', mesh: CUBE } as const;

describe('part subtypes', () => {
  it('recognises only the five values from the BambuStudio source', () => {
    expect(PART_SUBTYPES).toEqual([
      'normal_part',
      'negative_part',
      'modifier_part',
      'support_blocker',
      'support_enforcer',
    ]);
  });

  it('rejects misspelled subtypes', () => {
    // BambuStudio's type_from_string silently falls back to MODEL_PART for unrecognised strings:
    // "cut a piece away" becomes "add a solid piece", with no error message at all.
    // Measured on the same geometry: negative_part made a 20 mm cube 15 mm, normal_part made it 25 mm.
    expect(isPartSubtype('negative_part')).toBe(true);
    expect(isPartSubtype('negative-part')).toBe(false);
    expect(isPartSubtype('negativepart')).toBe(false);
    expect(isPartSubtype('')).toBe(false);
  });
});

describe('buildBambuProject', () => {
  it('produces the six container files BambuStudio needs', () => {
    const entries = readZipDirectory(project([BODY]));
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
      '3D/_rels/3dmodel.model.rels',
      '3D/Objects/object_1.model',
      'Metadata/model_settings.config',
    ]);
  });

  it('component objectids match part ids', () => {
    // This is the pivot of the whole format: if they don't match, subtypes are silently applied to the wrong parts.
    const buffer = project([BODY, { name: 'hole', subtype: 'negative_part', mesh: HOLE }]);
    const root = readZipEntry(buffer, '3D/3dmodel.model')!.toString('utf8');
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');

    const componentIds = [...root.matchAll(/objectid="(\d+)"/g)].map((m) => m[1]);
    const partIds = [...settings.matchAll(/<part id="(\d+)"/g)].map((m) => m[1]);

    // objectid also appears in <build><item>, so check for the part ones.
    expect(partIds).toEqual(['1', '2']);
    expect(componentIds).toContain('1');
    expect(componentIds).toContain('2');
  });

  it('writes the subtype into model_settings.config', () => {
    const buffer = project([BODY, { name: 'hole', subtype: 'negative_part', mesh: HOLE }]);
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(settings).toContain('subtype="normal_part"');
    expect(settings).toContain('subtype="negative_part"');
  });

  it('writes modifier per-part settings into the part block', () => {
    const buffer = project([
      BODY,
      {
        name: 'reinforce',
        subtype: 'modifier_part',
        mesh: HOLE,
        settings: { sparse_infill_density: '60%', wall_loops: '5' },
      },
    ]);
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(settings).toContain('key="sparse_infill_density" value="60%"');
    expect(settings).toContain('key="wall_loops" value="5"');
  });

  it('rejects an empty part list', () => {
    expect(() => project([])).toThrow(ThreeMfBuildError);
  });

  it('rejects a first part that is not the body', () => {
    // Without a solid body the negative part has nothing to act on, producing a valid but empty project.
    expect(() => project([{ name: 'hole', subtype: 'negative_part', mesh: HOLE }])).toThrow(
      /The first part must be a normal_part/,
    );
  });

  it('rejects an empty mesh', () => {
    expect(() =>
      project([BODY, { name: 'empty', subtype: 'negative_part', mesh: { vertices: [], triangles: [] } }]),
    ).toThrow(/has no triangles/);
  });

  it('escapes XML special characters in names', () => {
    const buffer = buildBambuProject({
      objectName: 'a & b <c>',
      parts: [{ name: '"quoted"', subtype: 'normal_part', mesh: CUBE }],
    });
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(settings).toContain('a &amp; b &lt;c&gt;');
    expect(settings).toContain('&quot;quoted&quot;');
  });

  it('does not write coordinates in scientific notation', () => {
    // Not every 3MF parser accepts notation like 1e-7.
    const tiny = buildPrimitive({ kind: 'box', size: { x: 0.0000001, y: 20, z: 20 } });
    const buffer = project([{ name: 'tiny', subtype: 'normal_part', mesh: tiny }]);
    const objects = readZipEntry(buffer, '3D/Objects/object_1.model')!.toString('utf8');
    expect(objects).not.toMatch(/[0-9]e-?[0-9]/i);
  });
});

describe('readProjectStructure', () => {
  it('reads back the written structure unchanged', () => {
    const buffer = project([
      BODY,
      { name: 'hole', subtype: 'negative_part', mesh: HOLE },
      { name: 'dense', subtype: 'modifier_part', mesh: HOLE, settings: { wall_loops: '5' } },
    ]);
    const xml = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    const objects = readProjectStructure(xml);

    expect(objects).toHaveLength(1);
    expect(objects[0]?.name).toBe('test');
    expect(objects[0]?.parts.map((part) => [part.name, part.subtype])).toEqual([
      ['body', 'normal_part'],
      ['hole', 'negative_part'],
      ['dense', 'modifier_part'],
    ]);
    expect(objects[0]?.parts[2]?.settings).toEqual({ wall_loops: '5' });
  });

  it('flags subtypes BambuStudio does not recognise', () => {
    const xml = `<config><object id="1">
      <part id="1" subtype="negative-part"><metadata key="name" value="x"/></part>
    </object></config>`;
    const parts = readProjectStructure(xml)[0]?.parts ?? [];
    expect(parts[0]?.recognised).toBe(false);
  });

  it('does not count matrix as a part setting', () => {
    const buffer = project([BODY]);
    const xml = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(readProjectStructure(xml)[0]?.parts[0]?.settings).toEqual({});
  });

  it('returns an empty array when it cannot parse, without guessing', () => {
    expect(readProjectStructure('this is not XML')).toEqual([]);
  });
});

describe('trianglesToIndexedMesh', () => {
  it('deduplicates repeated vertices', () => {
    // An STL cube has 12 triangles × 3 = 36 vertices, but only 8 distinct ones.
    const mesh = trianglesToIndexedMesh(boxTriangles([20, 20, 20]));
    expect(mesh.vertices).toHaveLength(8);
    expect(mesh.triangles).toHaveLength(12);
  });

  it('drops degenerate triangles', () => {
    const point = { x: 1, y: 1, z: 1 };
    const mesh = trianglesToIndexedMesh([
      { a: point, b: point, c: point, declaredNormal: point },
    ]);
    expect(mesh.triangles).toHaveLength(0);
  });
});
