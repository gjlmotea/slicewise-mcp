import { describe, expect, it } from 'vitest';

import {
  boxDistance,
  closestPointOnTriangle,
  distanceBetween,
  enclosesXY,
  TriangleSet,
} from '../../src/domain/model/triangle-set.js';
import type { Triangle } from '../../src/domain/model/stl.js';
import { boxTriangles } from '../fixtures/geometry.js';

/**
 * BVH 是整個間隙量測的地基，錯了不會爆炸、只會安靜地給錯數字。
 *
 * 所以這裡的主測試是對拍：同一批查詢分別走 BVH 與暴力全掃，答案必須完全一致。
 * 這種測試抓得到「剪枝剪太多」——也就是把該找到的最近點跳過去 ——
 * 而那正是空間索引最容易寫錯、也最難靠肉眼發現的地方。
 */

/** 決定性的偽亂數，讓失敗可以重現。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function bruteForceNearest(triangles: readonly Triangle[], p: { x: number; y: number; z: number }) {
  let best = Infinity;
  for (const triangle of triangles) {
    const d = distanceBetween(p, closestPointOnTriangle(p, triangle));
    if (d < best) best = d;
  }
  return best;
}

/** 一顆用經緯度切出來的球，三角形大小不均，足以壓到 BVH 的分割邏輯。 */
function sphere(radius: number, centre: { x: number; y: number; z: number }, bands = 14): Triangle[] {
  const triangles: Triangle[] = [];
  const at = (u: number, v: number) => {
    const theta = u * Math.PI;
    const phi = v * Math.PI * 2;
    return {
      x: centre.x + radius * Math.sin(theta) * Math.cos(phi),
      y: centre.y + radius * Math.sin(theta) * Math.sin(phi),
      z: centre.z + radius * Math.cos(theta),
    };
  };
  for (let i = 0; i < bands; i += 1) {
    for (let j = 0; j < bands * 2; j += 1) {
      const a = at(i / bands, j / (bands * 2));
      const b = at((i + 1) / bands, j / (bands * 2));
      const c = at((i + 1) / bands, (j + 1) / (bands * 2));
      const d = at(i / bands, (j + 1) / (bands * 2));
      const n = { x: 0, y: 0, z: 0 };
      triangles.push({ a, b, c, declaredNormal: n }, { a, b: c, c: d, declaredNormal: n });
    }
  }
  return triangles;
}

describe('BVH 對拍暴力解', () => {
  const shapes: readonly { name: string; triangles: readonly Triangle[] }[] = [
    { name: '立方體', triangles: boxTriangles([20, 20, 20], [0, 0, 0]) },
    { name: '球（三角形大小不均）', triangles: sphere(10, { x: 5, y: -3, z: 2 }) },
    { name: '扁平薄板', triangles: boxTriangles([80, 80, 0.4], [-40, -40, 0]) },
  ];

  for (const shape of shapes) {
    it(`${shape.name}：查詢結果與全掃一致`, () => {
      const set = new TriangleSet(shape.triangles);
      const random = makeRandom(20260823);

      for (let trial = 0; trial < 300; trial += 1) {
        const p = {
          x: (random() - 0.5) * 120,
          y: (random() - 0.5) * 120,
          z: (random() - 0.5) * 120,
        };
        const expected = bruteForceNearest(shape.triangles, p);
        // 搜尋上界故意設在真答案上下都有的位置，兩種情形都要測到。
        const limit = trial % 3 === 0 ? expected * 0.9 : expected + 5;
        const actual = set.nearestWithin(p, limit);

        if (limit <= expected) {
          // 上界比真答案小，就必須誠實回報找不到，而不是硬給一個更遠的點。
          expect(actual).toBeUndefined();
        } else {
          expect(actual).toBeDefined();
          expect(actual?.distance).toBeCloseTo(expected, 9);
        }
      }
    });
  }

  it('拒絕無限大的搜尋上界，而不是安靜地退化成全掃', () => {
    const set = new TriangleSet(boxTriangles([10, 10, 10], [0, 0, 0]));
    expect(() => set.nearestWithin({ x: 0, y: 0, z: 0 }, Infinity)).toThrow(/有限/);
  });

  it('空的三角形集合不會爆炸', () => {
    const set = new TriangleSet([]);
    expect(set.nearestWithin({ x: 0, y: 0, z: 0 }, 10)).toBeUndefined();
    set.forEachNear(set.box, 1, () => {
      throw new Error('空集合不該走訪到任何三角形');
    });
  });

  it('forEachNear 涵蓋所有真的在範圍內的三角形', () => {
    const triangles = sphere(10, { x: 0, y: 0, z: 0 });
    const set = new TriangleSet(triangles);
    const query = { min: { x: 8, y: -2, z: -2 }, max: { x: 12, y: 2, z: 2 }, size: { x: 4, y: 4, z: 4 } };

    const visited = new Set<number>();
    set.forEachNear(query, 0.5, (index) => {
      visited.add(index);
    });

    // 暴力算出「AABB 真的有交集」的清單，BVH 走訪必須是它的超集。
    for (let index = 0; index < triangles.length; index += 1) {
      if (boxDistance(set.boundsOf(index), query) <= 0.5) {
        expect(visited.has(index)).toBe(true);
      }
    }
  });
});

describe('外框工具', () => {
  it('boxDistance 重疊時為 0，分離時等於間隔', () => {
    const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 } };
    const b = { min: { x: 3, y: 0, z: 0 }, max: { x: 4, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 } };
    expect(boxDistance(a, b)).toBeCloseTo(2, 9);
    expect(boxDistance(a, a)).toBe(0);
  });

  it('enclosesXY 只看 XY，不管 Z', () => {
    const outer = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 1 }, size: { x: 10, y: 10, z: 1 } };
    const inner = { min: { x: 2, y: 2, z: 50 }, max: { x: 8, y: 8, z: 60 }, size: { x: 6, y: 6, z: 10 } };
    expect(enclosesXY(outer, inner)).toBe(true);
    expect(enclosesXY(inner, outer)).toBe(false);
  });
});
