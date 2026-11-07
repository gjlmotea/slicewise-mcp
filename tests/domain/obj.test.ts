import { describe, expect, it } from 'vitest';

import { loadMesh } from '../../src/domain/model/mesh-file.js';
import { looksLikeObj, ObjParseError, parseObj } from '../../src/domain/model/obj.js';
import { inspectModel } from '../../src/domain/model/stl.js';
import { boxTriangles, toAsciiStl, toBinaryStl } from '../fixtures/geometry.js';

/** Writes a box with quad faces, mimicking Tinkercad's OBJ export (one o + g + usemtl per shape). */
function boxObj(
  name: string,
  material: string,
  size: readonly [number, number, number],
  origin: readonly [number, number, number],
  offset: number,
): string {
  const [sx, sy, sz] = size;
  const [ox, oy, oz] = origin;
  const v = [
    [ox, oy, oz], [ox + sx, oy, oz], [ox + sx, oy + sy, oz], [ox, oy + sy, oz],
    [ox, oy, oz + sz], [ox + sx, oy, oz + sz], [ox + sx, oy + sy, oz + sz], [ox, oy + sy, oz + sz],
  ];
  // Four vertices per face, outward normals; indices start at 1, plus the vertices used by earlier objects.
  const quads = [
    [1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8],
  ];
  return [
    `o ${name}`,
    ...v.map(([x, y, z]) => `v ${x} ${y} ${z}`),
    `g group_${name}`,
    `usemtl ${material}`,
    ...quads.map((quad) => `f ${quad.map((i) => `${i + offset}/${i + offset}/${i + offset}`).join(' ')}`),
  ].join('\n');
}

describe('parseObj', () => {
  it('makes one part per o, splits quads into two triangles, and keeps material names', () => {
    const text = [
      '# Tinkercad style',
      'mtllib obj.mtl',
      boxObj('leg', 'color_green', [10, 10, 10], [0, 0, 0], 0),
      boxObj('banner', 'color_yellow', [30, 5, 5], [-10, 2, 10], 8),
    ].join('\n');

    const parts = parseObj(text);
    expect(parts.map((part) => part.name)).toEqual(['leg', 'banner']);
    expect(parts.map((part) => part.material)).toEqual(['color_green', 'color_yellow']);
    expect(parts.map((part) => part.triangles.length)).toEqual([12, 12]);

    // Fan triangulation must not flip the winding: the volume must equal the box volume and the mesh must be closed.
    const leg = inspectModel(parts[0]?.triangles ?? []);
    expect(leg.closed).toBe(true);
    expect(leg.volumeMm3).toBeCloseTo(1000, 6);
  });

  it('counts negative indices back from the vertices read so far', () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f -3 -2 -1'].join('\n');
    const [part] = parseObj(text, 'tri.obj');
    expect(part?.name).toBe('tri.obj');
    expect(part?.triangles[0]?.b).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('splits parts by g when there is no o', () => {
    const text = [
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1',
      'g first', 'f 1 2 3',
      'g second', 'f 1 2 4',
    ].join('\n');
    expect(parseObj(text).map((part) => part.name)).toEqual(['first', 'second']);
  });

  it('says so when there are no valid faces, instead of returning an empty model', () => {
    expect(() => parseObj('v 0 0 0\nf 1 2 9')).toThrow(ObjParseError);
  });
});

describe('looksLikeObj / loadMesh', () => {
  const obj = Buffer.from(boxObj('cube', 'red', [5, 5, 5], [0, 0, 0], 0), 'utf8');

  it('does not mistake ASCII STL vertex lines for OBJ', () => {
    expect(looksLikeObj(toAsciiStl(boxTriangles()))).toBe(false);
    expect(looksLikeObj(obj)).toBe(true);
  });

  it('routes by content: OBJ, ASCII STL and binary STL each take their own path', () => {
    expect(loadMesh(obj, 'cube.stl').format).toBe('obj');
    expect(loadMesh(toAsciiStl(boxTriangles()), 'a.obj').format).toBe('stl');
    expect(loadMesh(toBinaryStl(boxTriangles()), 'b.obj').format).toBe('stl');
  });
});
