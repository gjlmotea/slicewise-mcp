import { describe, expect, it } from 'vitest';

import {
  analysePrintability,
  DEFAULT_PRINTABILITY_OPTIONS,
} from '../../src/domain/model/printability.js';
import { boxTriangles, overhangingTriangles } from '../fixtures/geometry.js';

function codes(report: ReturnType<typeof analysePrintability>): readonly string[] {
  return report.findings.map((finding) => finding.code);
}

describe('analysePrintability', () => {
  it('does not treat a cube lying flat as needing support', () => {
    // The bottom face resting on the heated bed faces downward, but it lies on the plate.
    // Without the exclusion this would wrongly report 1/6 of the surface area as needing support.
    const report = analysePrintability(boxTriangles([20, 20, 20]));
    expect(report.overhangAreaRatio).toBe(0);
    expect(codes(report)).not.toContain('steep-overhang');
  });

  it('catches genuinely overhanging downward faces', () => {
    const report = analysePrintability(overhangingTriangles());
    expect(report.overhangAreaRatio).toBeGreaterThan(0);
    expect(codes(report)).toContain('steep-overhang');
  });

  it('marks exceeding the build volume as a blocker and gives a scale factor', () => {
    const report = analysePrintability(boxTriangles([300, 100, 100]));
    expect(report.fitsBuildVolume).toBe(false);
    const blocker = report.findings.find((finding) => finding.code === 'exceeds-build-volume');
    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.detail).toMatch(/%/);
  });

  it('reports no blocker when within the build volume', () => {
    const report = analysePrintability(boxTriangles([100, 100, 100]));
    expect(report.fitsBuildVolume).toBe(true);
    expect(report.findings.every((finding) => finding.severity !== 'blocker')).toBe(true);
  });

  it('warns about an open mesh and explains that the fix is not a setting', () => {
    const report = analysePrintability(boxTriangles([20, 20, 20]).slice(0, 10));
    const finding = report.findings.find((entry) => entry.code === 'non-manifold');
    expect(finding).toBeDefined();
    expect(finding?.detail).toMatch(/repair the mesh/);
  });

  it('flags the aspect-ratio risk for tall, slender parts', () => {
    const report = analysePrintability(boxTriangles([5, 5, 80]));
    expect(codes(report)).toContain('tall-and-narrow');
  });

  it('warns about thin features and states the blind spot of the check', () => {
    const report = analysePrintability(boxTriangles([0.3, 20, 20]));
    const finding = report.findings.find((entry) => entry.code === 'thin-feature');
    expect(finding).toBeDefined();
    // Honestly states that only the overall bounding box was checked.
    expect(finding?.detail).toMatch(/thin walls inside the model/);
  });

  it('sorts findings by severity', () => {
    const report = analysePrintability(boxTriangles([300, 300, 300]).slice(0, 10));
    const severities = report.findings.map((finding) => finding.severity);
    const rank = { blocker: 0, warning: 1, note: 2 } as const;
    const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
    expect(severities).toEqual(sorted);
  });

  it('accepts a custom build volume', () => {
    const small = analysePrintability(boxTriangles([200, 200, 200]), {
      ...DEFAULT_PRINTABILITY_OPTIONS,
      buildVolume: { x: 180, y: 180, z: 180 },
    });
    expect(small.fitsBuildVolume).toBe(false);
  });
});
