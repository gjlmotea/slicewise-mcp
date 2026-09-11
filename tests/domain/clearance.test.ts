import { describe, expect, it } from 'vitest';

import {
  analyseClearance,
  groupRigidBodies,
  minDistanceBetween,
} from '../../src/domain/model/clearance.js';
import type { MeshPart } from '../../src/domain/model/threemf-reader.js';
import { boxTriangles } from '../fixtures/geometry.js';

/**
 * 間隙量測的測試全部用「答案算得出來」的幾何。
 *
 * 拿真實模型當 fixture 只能驗「不會爆炸」，驗不到「數字對不對」——
 * 而這個工具的價值完全在數字對不對：0.09 mm 與 0.19 mm 的差別就是會不會黏死。
 */

function part(name: string, size: [number, number, number], origin: [number, number, number], extruder?: string): MeshPart {
  return {
    name,
    partId: name,
    extruder,
    triangles: boxTriangles(size, origin),
  };
}

describe('最小距離', () => {
  it('兩個分開的立方體，距離等於面與面的間隔', () => {
    const a = boxTriangles([10, 10, 10], [0, 0, 0]);
    const b = boxTriangles([10, 10, 10], [10.25, 0, 0]);

    const hit = minDistanceBetween(a, b);
    expect(hit?.distanceMm).toBeCloseTo(0.25, 4);
  });

  it('接觸的立方體距離為 0', () => {
    const a = boxTriangles([10, 10, 10], [0, 0, 0]);
    const b = boxTriangles([10, 10, 10], [10, 0, 0]);
    expect(minDistanceBetween(a, b)?.distanceMm).toBeCloseTo(0, 6);
  });

  it('錯開的立方體算的是角到角，不是面到面', () => {
    // X 與 Y 各差 3，最近的是兩個垂直邊，距離 sqrt(3² + 3²)。
    const a = boxTriangles([10, 10, 10], [0, 0, 0]);
    const b = boxTriangles([10, 10, 10], [13, 13, 0]);
    expect(minDistanceBetween(a, b)?.distanceMm).toBeCloseTo(Math.sqrt(18), 3);
  });

  it('面內最近點也找得到，不是只比對頂點', () => {
    // 小方塊懸在大平板正上方 0.4 mm，最近點落在平板頂面的內部而不是任何頂點。
    const plate = boxTriangles([50, 50, 2], [0, 0, 0]);
    const cube = boxTriangles([2, 2, 2], [24, 24, 2.4]);
    expect(minDistanceBetween(plate, cube)?.distanceMm).toBeCloseTo(0.4, 3);
  });
});

describe('剛體分群', () => {
  it('貼合的零件併成同一顆實體', () => {
    // 同一根柱子被切成上下兩段換色 —— 這正是 Bambu 多色 3MF 的存法。
    const parts = [
      part('column_lower', [10, 10, 5], [0, 0, 0], '1'),
      part('column_upper', [10, 10, 5], [0, 0, 5], '2'),
    ];
    const bodies = groupRigidBodies(parts);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.partNames).toEqual(['column_lower', 'column_upper']);
    expect(bodies[0]?.extruders).toEqual(['1', '2']);
  });

  it('隔著設計公差的零件不會被誤併', () => {
    const parts = [
      part('gear_a', [10, 10, 5], [0, 0, 0]),
      part('gear_b', [10, 10, 5], [10.09, 0, 0]),
    ];
    expect(groupRigidBodies(parts)).toHaveLength(2);
  });

  it('互相穿透的零件視為同一顆實體', () => {
    const parts = [
      part('ring', [20, 20, 5], [0, 0, 0]),
      part('stud', [4, 4, 4], [8, 8, 3]),
    ];
    expect(groupRigidBodies(parts)).toHaveLength(1);
  });
});

describe('間隙報告', () => {
  const tight = [
    part('gear_a', [10, 10, 5], [0, 0, 0]),
    part('gear_b', [10, 10, 5], [10.09, 0, 0]),
  ];

  it('間隙低於門檻時判定會黏死並給補償建議', () => {
    const report = analyseClearance(tight, '3mf');
    expect(report.bodies).toHaveLength(2);
    expect(report.tightestGapMm).toBeCloseTo(0.09, 3);
    expect(report.pairs[0]?.verdict).toBe('will-fuse');

    // 0.15 - 0.09 = 0.06，兩側各讓 0.03。
    expect(report.recommendation?.xy_contour_compensation).toBe('-0.030');
  });

  it('間隙足夠時不給補償建議', () => {
    const roomy = [
      part('gear_a', [10, 10, 5], [0, 0, 0]),
      part('gear_b', [10, 10, 5], [10.4, 0, 0]),
    ];
    const report = analyseClearance(roomy, '3mf');
    expect(report.pairs[0]?.verdict).toBe('adequate');
    expect(report.recommendation).toBeUndefined();
  });

  it('門檻可以調整，換材料或換噴頭時判定會跟著變', () => {
    const report = analyseClearance(tight, '3mf', {
      minimumClearanceMm: 0.05,
      reportThresholdMm: 2,
      fuseEpsilonMm: 1e-3,
    });
    expect(report.pairs[0]?.verdict).toBe('adequate');
  });

  it('認得出包覆關係，並據此指向 xy_hole_compensation', () => {
    // 內圈完全被外圈的外框包住 —— 外圈那一側在切片器眼中是「孔」。
    const parts = [
      part('outer_ring', [40, 40, 5], [0, 0, 0]),
      part('inner', [4, 4, 5], [18, 18, 0]),
    ];
    // 讓兩者不接觸：把內件縮小並置中，靠 reportThreshold 抓到。
    const report = analyseClearance(
      [parts[0] as MeshPart, part('inner', [4, 4, 5], [18, 18, 6])],
      '3mf',
    );
    const pair = report.pairs[0];
    expect(pair?.enclosure).toBe('a-encloses-b');
    expect(report.recommendation?.xy_hole_compensation).not.toBe('0');
  });

  it('只有一顆實體時明說沒有可動零件，而不是回空報告', () => {
    const report = analyseClearance([part('solid', [10, 10, 10], [0, 0, 0])], '3mf');
    expect(report.bodies).toHaveLength(1);
    expect(report.pairs).toHaveLength(0);
    expect(report.findings.join('')).toContain('只找到一顆實體');
  });
});
