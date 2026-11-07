import { describe, expect, it } from 'vitest';

import { findFloatingBodies, pointInsideMesh, splitShells } from '../../src/domain/model/floating.js';
import { analysePrintability } from '../../src/domain/model/printability.js';
import type { MeshPart } from '../../src/domain/model/threemf-reader.js';
import { boxTriangles } from '../fixtures/geometry.js';

type Point = readonly [number, number, number];

function part(name: string, size: Point, origin: Point, subtype?: string): MeshPart {
  return {
    name,
    partId: name,
    extruder: undefined,
    ...(subtype === undefined ? {} : { subtype }),
    triangles: boxTriangles(size, origin),
  };
}

/**
 * A scaled-down version of the 2026-11-07 birthday-cake topper: two legs end at z=50, and the
 * body starts at z=51. Bambu Studio reports "Levitating objects" for the original file.
 */
function topper(bodyBottom: number): MeshPart[] {
  return [
    part('leg_left', [18, 17, 49], [-29, -14, 1]),
    part('leg_right', [18, 17, 49], [-29, 9, 1]),
    part('body', [22, 47, 100 - bodyBottom], [-30, -19, bodyBottom]),
    part('banner', [32, 222, 71], [-45, -130, 99]),
    // An eye fully enclosed by the banner: no surface contact with anything, but absorbed by
    // the union at slicing time.
    part('eye', [11, 11, 2], [-37, -5, 117]),
  ];
}

describe('findFloatingBodies', () => {
  it('catches the 1 mm gap between the legs and the body', () => {
    const report = findFloatingBodies(topper(51));
    expect(report.floating).toHaveLength(1);
    const [floating] = report.floating;
    // Body, banner and eye are one piece: the body and banner interpenetrate, and the eye is
    // enclosed by the banner.
    expect(floating?.partNames.slice().sort()).toEqual(['banner', 'body', 'eye']);
    expect(floating?.liftMm).toBeCloseTo(50, 6);
    expect(floating?.gapMm).toBeCloseTo(1, 3);
    expect(['leg_left', 'leg_right']).toContain(floating?.nearestBody);
  });

  it('reports nothing floating once the legs are extended 1.5 mm into the body', () => {
    const fixed = topper(51).map((p) =>
      p.name.startsWith('leg') ? { ...p, triangles: boxTriangles([18, 17, 50.5], [-29, p.name === 'leg_left' ? -14 : 9, 1]) } : p,
    );
    const report = findFloatingBodies(fixed);
    expect(report.floating).toEqual([]);
    expect(report.bodyCount).toBe(1);
  });

  it('does not count an enclosed solid as floating', () => {
    const report = findFloatingBodies([
      part('shell', [20, 20, 20], [0, 0, 0]),
      part('core', [4, 4, 4], [8, 8, 8]),
    ]);
    expect(report.floating).toEqual([]);
  });

  it('does not count a solid inside the intersection of two overlapping boxes as floating (parity test must be per shell)', () => {
    // Counting crossings over a whole solid: the point is inside two shells → odd + odd = even
    // → wrongly judged to be outside. This is how the real birthday topper got an enclosed
    // part reported as floating.
    const report = findFloatingBodies([
      part('left', [20, 20, 20], [0, 0, 0]),
      part('right', [20, 20, 20], [10, 0, 0]),
      part('core', [4, 4, 4], [12, 8, 8]),
    ]);
    expect(report.floating).toEqual([]);
  });

  it('points the nearest solid at the one standing on the plate, not at another floating neighbour', () => {
    const report = findFloatingBodies([
      part('ground', [10, 10, 10], [0, 0, 0]),
      part('floater', [10, 10, 5], [0, 0, 11]), // 1 mm from ground
      part('neighbour', [10, 10, 5], [0, 10.2, 11]), // 0.2 mm from floater, itself floating
    ]);
    const floater = report.floating.find((body) => body.name === 'floater');
    expect(floater?.nearestBody).toBe('ground');
    expect(floater?.gapMm).toBeCloseTo(1, 3);
  });

  it('ignores parts that are never printed, such as modifiers and negative volumes', () => {
    const report = findFloatingBodies([
      part('base', [20, 20, 5], [0, 0, 0]),
      part('infill_zone', [5, 5, 5], [5, 5, 30], 'modifier_part'),
      part('hole', [5, 5, 5], [5, 5, 40], 'negative_part'),
    ]);
    expect(report.floating).toEqual([]);
  });

  it('works on STL without part boundaries: one triangle soup is split into shells by shared vertices', () => {
    const soup: MeshPart = {
      name: 'soup.stl',
      partId: '1',
      extruder: undefined,
      triangles: [...boxTriangles([10, 10, 10], [0, 0, 0]), ...boxTriangles([10, 10, 10], [0, 0, 12])],
    };
    const report = findFloatingBodies([soup]);
    expect(report.floating).toHaveLength(1);
    expect(report.floating[0]?.gapMm).toBeCloseTo(2, 3);
  });
});

describe('analysePrintability floating findings', () => {
  it('treats a narrow gap as a missed modelling join: blocker, and does not recommend support', () => {
    const parts = topper(51);
    const report = analysePrintability(
      parts.flatMap((p) => p.triangles),
      undefined,
      parts,
    );
    const finding = report.findings.find((f) => f.code === 'floating-part');
    expect(finding?.severity).toBe('blocker');
    expect(finding?.relatedParameters).toEqual([]);
    expect(report.floatingBodies[0]?.gapMm).toBeCloseTo(1, 3);
    // Blockers are sorted first.
    expect(report.findings[0]?.code).toBe('floating-part');
  });

  it('treats a wide gap as genuinely floating: recommends support', () => {
    const parts = [part('base', [10, 10, 10], [0, 0, 0]), part('cloud', [10, 10, 10], [0, 0, 30])];
    const report = analysePrintability(
      parts.flatMap((p) => p.triangles),
      undefined,
      parts,
    );
    const finding = report.findings.find((f) => f.code === 'floating-part');
    expect(finding?.relatedParameters).toContain('enable_support');
  });

  it('has no floating finding for a single-solid model', () => {
    const report = analysePrintability(boxTriangles([20, 20, 20]));
    expect(report.floatingBodies).toEqual([]);
    expect(report.findings.map((f) => f.code)).not.toContain('floating-part');
  });
});

describe('geometry helpers', () => {
  it('splitShells splits into shells by shared vertices', () => {
    const shells = splitShells([...boxTriangles([1, 1, 1]), ...boxTriangles([1, 1, 1], [5, 0, 0])]);
    expect(shells).toHaveLength(2);
    expect(shells.map((s) => s.length)).toEqual([12, 12]);
  });

  it('pointInsideMesh does not miscount at positions aligned with box edges', () => {
    const box = boxTriangles([10, 10, 10]);
    expect(pointInsideMesh({ x: 5, y: 5, z: 5 }, box)).toBe(true);
    expect(pointInsideMesh({ x: 0.5, y: 0.5, z: 0.5 }, box)).toBe(true);
    expect(pointInsideMesh({ x: 15, y: 5, z: 5 }, box)).toBe(false);
    expect(pointInsideMesh({ x: 5, y: 5, z: -1 }, box)).toBe(false);
  });
});
