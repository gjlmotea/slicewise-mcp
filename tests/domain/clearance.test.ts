import { describe, expect, it } from 'vitest';

import {
  analyseClearance,
  groupRigidBodies,
  minDistanceBetween,
} from '../../src/domain/model/clearance.js';
import type { MeshPart } from '../../src/domain/model/threemf-reader.js';
import { boxTriangles } from '../fixtures/geometry.js';

/**
 * Every clearance test uses geometry whose answer can be computed by hand.
 *
 * Using a real model as a fixture only verifies "it does not blow up", not "the number is
 * right", and this tool's value lies entirely in the number being right: the difference
 * between 0.09 mm and 0.19 mm is the difference between fusing and moving.
 */

function part(name: string, size: [number, number, number], origin: [number, number, number], extruder?: string): MeshPart {
  return {
    name,
    partId: name,
    extruder,
    triangles: boxTriangles(size, origin),
  };
}

describe('minimum distance', () => {
  it('for two separated cubes, equals the face-to-face spacing', () => {
    const a = boxTriangles([10, 10, 10], [0, 0, 0]);
    const b = boxTriangles([10, 10, 10], [10.25, 0, 0]);

    const hit = minDistanceBetween(a, b);
    expect(hit?.distanceMm).toBeCloseTo(0.25, 4);
  });

  it('is 0 for touching cubes', () => {
    const a = boxTriangles([10, 10, 10], [0, 0, 0]);
    const b = boxTriangles([10, 10, 10], [10, 0, 0]);
    expect(minDistanceBetween(a, b)?.distanceMm).toBeCloseTo(0, 6);
  });

  it('for offset cubes, is measured corner to corner, not face to face', () => {
    // Offset by 3 in both X and Y; the closest features are two vertical edges, sqrt(3² + 3²) apart.
    const a = boxTriangles([10, 10, 10], [0, 0, 0]);
    const b = boxTriangles([10, 10, 10], [13, 13, 0]);
    expect(minDistanceBetween(a, b)?.distanceMm).toBeCloseTo(Math.sqrt(18), 3);
  });

  it('finds closest points inside a face, not only at vertices', () => {
    // A small cube hovers 0.4 mm above a large plate; the closest point is inside the plate's
    // top face, not at any vertex.
    const plate = boxTriangles([50, 50, 2], [0, 0, 0]);
    const cube = boxTriangles([2, 2, 2], [24, 24, 2.4]);
    expect(minDistanceBetween(plate, cube)?.distanceMm).toBeCloseTo(0.4, 3);
  });
});

describe('rigid-body grouping', () => {
  it('merges coincident parts into one solid', () => {
    // One column cut into upper and lower halves for a colour change; this is exactly how
    // Bambu multi-colour 3MF files store it.
    const parts = [
      part('column_lower', [10, 10, 5], [0, 0, 0], '1'),
      part('column_upper', [10, 10, 5], [0, 0, 5], '2'),
    ];
    const bodies = groupRigidBodies(parts);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.partNames).toEqual(['column_lower', 'column_upper']);
    expect(bodies[0]?.extruders).toEqual(['1', '2']);
  });

  it('does not merge parts separated by a design tolerance', () => {
    const parts = [
      part('gear_a', [10, 10, 5], [0, 0, 0]),
      part('gear_b', [10, 10, 5], [10.09, 0, 0]),
    ];
    expect(groupRigidBodies(parts)).toHaveLength(2);
  });

  it('treats interpenetrating parts as one solid', () => {
    const parts = [
      part('ring', [20, 20, 5], [0, 0, 0]),
      part('stud', [4, 4, 4], [8, 8, 3]),
    ];
    expect(groupRigidBodies(parts)).toHaveLength(1);
  });
});

describe('clearance report', () => {
  const tight = [
    part('gear_a', [10, 10, 5], [0, 0, 0]),
    part('gear_b', [10, 10, 5], [10.09, 0, 0]),
  ];

  it('judges a clearance below the threshold as will-fuse and recommends compensation', () => {
    const report = analyseClearance(tight, '3mf');
    expect(report.bodies).toHaveLength(2);
    expect(report.tightestGapMm).toBeCloseTo(0.09, 3);
    expect(report.pairs[0]?.verdict).toBe('will-fuse');

    // 0.15 - 0.09 = 0.06, so each side gives up 0.03.
    expect(report.recommendation?.xy_contour_compensation).toBe('-0.030');
  });

  it('gives no compensation recommendation when the clearance is sufficient', () => {
    const roomy = [
      part('gear_a', [10, 10, 5], [0, 0, 0]),
      part('gear_b', [10, 10, 5], [10.4, 0, 0]),
    ];
    const report = analyseClearance(roomy, '3mf');
    expect(report.pairs[0]?.verdict).toBe('adequate');
    expect(report.recommendation).toBeUndefined();
  });

  it('has an adjustable threshold, so the verdict changes with material or nozzle', () => {
    const report = analyseClearance(tight, '3mf', {
      minimumClearanceMm: 0.05,
      reportThresholdMm: 2,
      fuseEpsilonMm: 1e-3,
    });
    expect(report.pairs[0]?.verdict).toBe('adequate');
  });

  it('recognises enclosure and points to xy_hole_compensation accordingly', () => {
    // The inner part is fully enclosed by the outer ring's bounding box; to the slicer, the
    // outer ring's side is a "hole".
    const parts = [
      part('outer_ring', [40, 40, 5], [0, 0, 0]),
      part('inner', [4, 4, 5], [18, 18, 0]),
    ];
    // Keep the two from touching: shrink and centre the inner part, and let reportThreshold catch it.
    const report = analyseClearance(
      [parts[0] as MeshPart, part('inner', [4, 4, 5], [18, 18, 6])],
      '3mf',
    );
    const pair = report.pairs[0];
    expect(pair?.enclosure).toBe('a-encloses-b');
    expect(report.recommendation?.xy_hole_compensation).not.toBe('0');
  });

  it('says plainly that there are no moving parts when there is only one solid, instead of returning an empty report', () => {
    const report = analyseClearance([part('solid', [10, 10, 10], [0, 0, 0])], '3mf');
    expect(report.bodies).toHaveLength(1);
    expect(report.pairs).toHaveLength(0);
    expect(report.findings.join('')).toContain('Only one solid was found');
  });
});
