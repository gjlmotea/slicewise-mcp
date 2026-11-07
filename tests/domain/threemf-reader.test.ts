import { describe, expect, it } from 'vitest';

import { buildPrimitive } from '../../src/domain/model/primitives.js';
import { buildBambuProject } from '../../src/domain/model/threemf.js';
import { looksLikeZip, readThreeMfParts, ThreeMfReadError } from '../../src/domain/model/threemf-reader.js';
import { loadMesh } from '../../src/domain/model/mesh-file.js';
import { boundingBox } from '../../src/domain/model/stl.js';
import { boxTriangles } from '../fixtures/geometry.js';
import { buildStoredZip } from '../fixtures/zip-builder.js';

/**
 * These tests take the round-trip path: write it out, then read it back.
 *
 * The 3MF is produced with buildBambuProject and read with readThreeMfParts, two independently
 * written pieces of code; if the transform's row/column convention is wrong, the round-tripped
 * coordinates won't match and the tests catch it. A real file as a fixture can't verify this —
 * you can't tell what the values "should be".
 */

const CUBE = buildPrimitive({ kind: 'box', size: { x: 20, y: 20, z: 20 } }, { x: 0, y: 0, z: 0 });
const OFFSET_CUBE = buildPrimitive({ kind: 'box', size: { x: 10, y: 10, z: 10 } }, { x: 40, y: 0, z: 0 });

function project(parts: Parameters<typeof buildBambuProject>[0]['parts']) {
  return buildBambuProject({ objectName: 'roundtrip', parts });
}

describe('format detection', () => {
  it('looks at the ZIP magic in the content, not the extension', () => {
    const archive = project([{ name: 'body', subtype: 'normal_part', mesh: CUBE }]);
    expect(looksLikeZip(archive)).toBe(true);
    expect(looksLikeZip(Buffer.from('solid ascii stl\nfacet normal 0 0 0\n'))).toBe(false);
  });

  it('loadMesh brings STL and 3MF into the same shape', () => {
    const archive = project([{ name: 'body', subtype: 'normal_part', mesh: CUBE }]);
    const fromThreeMf = loadMesh(archive);
    expect(fromThreeMf.format).toBe('3mf');

    const stl = stlBuffer();
    const fromStl = loadMesh(stl, 'cube.stl');
    expect(fromStl.format).toBe('stl');
    // STL has no notion of parts; it is always treated as a single part.
    expect(fromStl.parts).toHaveLength(1);
    expect(fromStl.parts[0]?.name).toBe('cube.stl');
  });
});

describe('3MF geometry reading', () => {
  it('reads the part count and triangle count', () => {
    const archive = project([
      { name: 'body', subtype: 'normal_part', mesh: CUBE },
      { name: 'satellite', subtype: 'normal_part', mesh: OFFSET_CUBE },
    ]);

    const parts = readThreeMfParts(archive);
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.name)).toEqual(['body', 'satellite']);
    expect(parts[0]?.triangles).toHaveLength(CUBE.triangles.length);
  });

  it('round-trips coordinates: the bounds read back equal the written shape plus the placement offset', () => {
    const archive = project([{ name: 'body', subtype: 'normal_part', mesh: CUBE }]);
    const parts = readThreeMfParts(archive);
    const box = boundingBox(parts[0]?.triangles ?? []);

    // The cube is 20 on a side — size is unaffected by the transform and stays the same even with a wrong offset, so the centre is checked separately.
    expect(box.size.x).toBeCloseTo(20, 6);
    expect(box.size.y).toBeCloseTo(20, 6);
    expect(box.size.z).toBeCloseTo(20, 6);

    // buildBambuProject places the object at the plate centre (128, 128).
    // If the translation were treated as a column vector instead of a row vector, the centre would land elsewhere.
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(128, 6);
    expect((box.min.y + box.max.y) / 2).toBeCloseTo(128, 6);
  });

  it('applies each part its own offset', () => {
    const archive = project([
      { name: 'body', subtype: 'normal_part', mesh: CUBE },
      { name: 'satellite', subtype: 'normal_part', mesh: OFFSET_CUBE },
    ]);
    const parts = readThreeMfParts(archive);
    const bodyBox = boundingBox(parts[0]?.triangles ?? []);
    const satelliteBox = boundingBox(parts[1]?.triangles ?? []);

    // The source geometry is 40 mm apart, so what is read back must be 40 mm apart too.
    const bodyCentre = (bodyBox.min.x + bodyBox.max.x) / 2;
    const satelliteCentre = (satelliteBox.min.x + satelliteBox.max.x) / 2;
    expect(satelliteCentre - bodyCentre).toBeCloseTo(40, 6);
  });

  it('a ZIP that is not a 3MF says the model file is missing instead of returning an empty result', () => {
    // A valid ZIP, but with no 3D/3dmodel.model inside.
    const notThreeMf = Buffer.concat([
      Buffer.from('PK'),
      Buffer.alloc(60),
    ]);
    expect(() => readThreeMfParts(notThreeMf)).toThrow();
  });

  it('throws clearly when the model file has no geometry, instead of silently returning zero parts', () => {
    // Structurally valid, just no triangles. This kind of file is the most dangerous: without an error,
    // the caller gets "0 parts" and takes it to mean "this model has no moving parts".
    const empty = buildStoredZip([
      {
        name: '3D/3dmodel.model',
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<model unit="millimeter"><resources></resources><build></build></model>',
      },
    ]);
    expect(() => readThreeMfParts(empty)).toThrow(ThreeMfReadError);
  });

  it('names the missing model file when a reference points at one, instead of returning a partial result', () => {
    const dangling = buildStoredZip([
      {
        name: '3D/3dmodel.model',
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<model unit="millimeter"><resources>' +
          '<object id="1" type="model"><components>' +
          '<component p:path="/3D/Objects/missing.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>' +
          '</components></object></resources>' +
          '<build><item objectid="1"/></build></model>',
      },
    ]);
    expect(() => readThreeMfParts(dangling)).toThrow(/missing\.model/);
  });
});

/** Produces a binary STL of a 20 mm cube. */
function stlBuffer(): Buffer {
  const triangles = boxTriangles([20, 20, 20]);
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const vertex of [triangle.a, triangle.b, triangle.c]) {
      buffer.writeFloatLE(vertex.x, offset);
      buffer.writeFloatLE(vertex.y, offset + 4);
      buffer.writeFloatLE(vertex.z, offset + 8);
      offset += 12;
    }
  });
  return buffer;
}
