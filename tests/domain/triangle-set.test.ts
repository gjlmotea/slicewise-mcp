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
 * The BVH is the foundation of all clearance measurement; when it is wrong it does not blow
 * up, it just quietly returns wrong numbers.
 *
 * So the main test here is a differential test: the same batch of queries goes through both
 * the BVH and a brute-force full scan, and the answers must match exactly. This kind of test
 * catches "over-pruning", i.e. skipping a closest point that should have been found, which is
 * exactly where spatial indexes are easiest to get wrong and hardest to spot by eye.
 */

/** Deterministic pseudo-random numbers so failures are reproducible. */
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

/** A sphere tessellated by latitude/longitude; uneven triangle sizes are enough to stress the BVH split logic. */
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

describe('BVH versus brute force', () => {
  const shapes: readonly { name: string; triangles: readonly Triangle[] }[] = [
    { name: 'cube', triangles: boxTriangles([20, 20, 20], [0, 0, 0]) },
    { name: 'sphere (uneven triangle sizes)', triangles: sphere(10, { x: 5, y: -3, z: 2 }) },
    { name: 'flat thin plate', triangles: boxTriangles([80, 80, 0.4], [-40, -40, 0]) },
  ];

  for (const shape of shapes) {
    it(`${shape.name}: query results match a full scan`, () => {
      const set = new TriangleSet(shape.triangles);
      const random = makeRandom(20260823);

      for (let trial = 0; trial < 300; trial += 1) {
        const p = {
          x: (random() - 0.5) * 120,
          y: (random() - 0.5) * 120,
          z: (random() - 0.5) * 120,
        };
        const expected = bruteForceNearest(shape.triangles, p);
        // The search bound is deliberately placed both below and above the true answer, so both cases are tested.
        const limit = trial % 3 === 0 ? expected * 0.9 : expected + 5;
        const actual = set.nearestWithin(p, limit);

        if (limit <= expected) {
          // When the bound is below the true answer, it must honestly report nothing found rather
          // than force out a farther point.
          expect(actual).toBeUndefined();
        } else {
          expect(actual).toBeDefined();
          expect(actual?.distance).toBeCloseTo(expected, 9);
        }
      }
    });
  }

  it('rejects an infinite search bound instead of quietly degrading into a full scan', () => {
    const set = new TriangleSet(boxTriangles([10, 10, 10], [0, 0, 0]));
    expect(() => set.nearestWithin({ x: 0, y: 0, z: 0 }, Infinity)).toThrow(/finite/);
  });

  it('does not blow up on an empty triangle set', () => {
    const set = new TriangleSet([]);
    expect(set.nearestWithin({ x: 0, y: 0, z: 0 }, 10)).toBeUndefined();
    set.forEachNear(set.box, 1, () => {
      throw new Error('an empty set should not visit any triangle');
    });
  });

  it('forEachNear covers every triangle that is actually in range', () => {
    const triangles = sphere(10, { x: 0, y: 0, z: 0 });
    const set = new TriangleSet(triangles);
    const query = { min: { x: 8, y: -2, z: -2 }, max: { x: 12, y: 2, z: 2 }, size: { x: 4, y: 4, z: 4 } };

    const visited = new Set<number>();
    set.forEachNear(query, 0.5, (index) => {
      visited.add(index);
    });

    // Brute-force the list of triangles whose AABBs really intersect; the BVH visit must be a superset of it.
    for (let index = 0; index < triangles.length; index += 1) {
      if (boxDistance(set.boundsOf(index), query) <= 0.5) {
        expect(visited.has(index)).toBe(true);
      }
    }
  });
});

describe('bounding-box helpers', () => {
  it('boxDistance is 0 when overlapping and equals the spacing when separated', () => {
    const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 } };
    const b = { min: { x: 3, y: 0, z: 0 }, max: { x: 4, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 } };
    expect(boxDistance(a, b)).toBeCloseTo(2, 9);
    expect(boxDistance(a, a)).toBe(0);
  });

  it('enclosesXY looks only at XY and ignores Z', () => {
    const outer = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 1 }, size: { x: 10, y: 10, z: 1 } };
    const inner = { min: { x: 2, y: 2, z: 50 }, max: { x: 8, y: 8, z: 60 }, size: { x: 6, y: 6, z: 10 } };
    expect(enclosesXY(outer, inner)).toBe(true);
    expect(enclosesXY(inner, outer)).toBe(false);
  });
});
