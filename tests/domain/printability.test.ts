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
  it('平躺的方塊不會被當成需要支撐', () => {
    // 貼在熱床上的底面雖然朝下，但它躺在平台上。
    // 沒有排除的話這裡會誤報 1/6 的表面積需要支撐。
    const report = analysePrintability(boxTriangles([20, 20, 20]));
    expect(report.overhangAreaRatio).toBe(0);
    expect(codes(report)).not.toContain('steep-overhang');
  });

  it('抓到真正懸空的朝下面', () => {
    const report = analysePrintability(overhangingTriangles());
    expect(report.overhangAreaRatio).toBeGreaterThan(0);
    expect(codes(report)).toContain('steep-overhang');
  });

  it('超出列印範圍時標為 blocker 並給出縮放比例', () => {
    const report = analysePrintability(boxTriangles([300, 100, 100]));
    expect(report.fitsBuildVolume).toBe(false);
    const blocker = report.findings.find((finding) => finding.code === 'exceeds-build-volume');
    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.detail).toMatch(/%/);
  });

  it('在列印範圍內時不報 blocker', () => {
    const report = analysePrintability(boxTriangles([100, 100, 100]));
    expect(report.fitsBuildVolume).toBe(true);
    expect(report.findings.every((finding) => finding.severity !== 'blocker')).toBe(true);
  });

  it('網格未封閉時提出警告並說明正解不是調參數', () => {
    const report = analysePrintability(boxTriangles([20, 20, 20]).slice(0, 10));
    const finding = report.findings.find((entry) => entry.code === 'non-manifold');
    expect(finding).toBeDefined();
    expect(finding?.detail).toMatch(/修復網格/);
  });

  it('細高件標記高寬比風險', () => {
    const report = analysePrintability(boxTriangles([5, 5, 80]));
    expect(codes(report)).toContain('tall-and-narrow');
  });

  it('特徵過薄時警告並說明檢查的盲點', () => {
    const report = analysePrintability(boxTriangles([0.3, 20, 20]));
    const finding = report.findings.find((entry) => entry.code === 'thin-feature');
    expect(finding).toBeDefined();
    // 誠實說明只檢查了整體外框。
    expect(finding?.detail).toMatch(/內部的薄壁/);
  });

  it('findings 依嚴重度排序', () => {
    const report = analysePrintability(boxTriangles([300, 300, 300]).slice(0, 10));
    const severities = report.findings.map((finding) => finding.severity);
    const rank = { blocker: 0, warning: 1, note: 2 } as const;
    const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
    expect(severities).toEqual(sorted);
  });

  it('接受自訂列印範圍', () => {
    const small = analysePrintability(boxTriangles([200, 200, 200]), {
      ...DEFAULT_PRINTABILITY_OPTIONS,
      buildVolume: { x: 180, y: 180, z: 180 },
    });
    expect(small.fitsBuildVolume).toBe(false);
  });
});
