import { describe, expect, it } from 'vitest';

import { loadMesh } from '../../src/domain/model/mesh-file.js';
import { looksLikeObj, ObjParseError, parseObj } from '../../src/domain/model/obj.js';
import { inspectModel } from '../../src/domain/model/stl.js';
import { boxTriangles, toAsciiStl, toBinaryStl } from '../fixtures/geometry.js';

/** 以四邊形面寫出一個長方體，模擬 Tinkercad 的 OBJ 匯出（每個形狀一個 o＋g＋usemtl）。 */
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
  // 每個面四個頂點、外法向；索引從 1 開始，加上前面物件已用掉的頂點數。
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
  it('每個 o 一個零件，四邊形面拆成兩個三角形，材質名稱保留', () => {
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

    // 繞序沒被扇形三角化弄反：體積要等於長方體體積，網格要封閉。
    const leg = inspectModel(parts[0]?.triangles ?? []);
    expect(leg.closed).toBe(true);
    expect(leg.volumeMm3).toBeCloseTo(1000, 6);
  });

  it('負索引從目前已讀到的頂點往回數', () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f -3 -2 -1'].join('\n');
    const [part] = parseObj(text, 'tri.obj');
    expect(part?.name).toBe('tri.obj');
    expect(part?.triangles[0]?.b).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('沒有 o 時以 g 分零件', () => {
    const text = [
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1',
      'g first', 'f 1 2 3',
      'g second', 'f 1 2 4',
    ].join('\n');
    expect(parseObj(text).map((part) => part.name)).toEqual(['first', 'second']);
  });

  it('沒有任何有效面時明說，而不是回一個空模型', () => {
    expect(() => parseObj('v 0 0 0\nf 1 2 9')).toThrow(ObjParseError);
  });
});

describe('looksLikeObj／loadMesh', () => {
  const obj = Buffer.from(boxObj('cube', 'red', [5, 5, 5], [0, 0, 0], 0), 'utf8');

  it('ASCII STL 的 vertex 行不會被認成 OBJ', () => {
    expect(looksLikeObj(toAsciiStl(boxTriangles()))).toBe(false);
    expect(looksLikeObj(obj)).toBe(true);
  });

  it('依內容分流：OBJ、ASCII STL、binary STL 各走各的', () => {
    expect(loadMesh(obj, 'cube.stl').format).toBe('obj');
    expect(loadMesh(toAsciiStl(boxTriangles()), 'a.obj').format).toBe('stl');
    expect(loadMesh(toBinaryStl(boxTriangles()), 'b.obj').format).toBe('stl');
  });
});
