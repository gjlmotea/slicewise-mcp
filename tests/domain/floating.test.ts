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
 * 2026-11-07 生日蛋糕插牌的縮小版：兩隻腳頂在 z=50，身體從 z=51 開始。
 * Bambu Studio 對原檔報 Levitating objects。
 */
function topper(bodyBottom: number): MeshPart[] {
  return [
    part('leg_left', [18, 17, 49], [-29, -14, 1]),
    part('leg_right', [18, 17, 49], [-29, 9, 1]),
    part('body', [22, 47, 100 - bodyBottom], [-30, -19, bodyBottom]),
    part('banner', [32, 222, 71], [-45, -130, 99]),
    // 整個包在橫幅裡的眼睛：跟誰都沒有表面接觸，但切片時會被聯集吃掉。
    part('eye', [11, 11, 2], [-37, -5, 117]),
  ];
}

describe('findFloatingBodies', () => {
  it('抓到腳和身體之間那條 1 mm 的縫', () => {
    const report = findFloatingBodies(topper(51));
    expect(report.floating).toHaveLength(1);
    const [floating] = report.floating;
    // 身體、橫幅、眼睛是同一塊：身體與橫幅互相穿透，眼睛被橫幅包住。
    expect(floating?.partNames.slice().sort()).toEqual(['banner', 'body', 'eye']);
    expect(floating?.liftMm).toBeCloseTo(50, 6);
    expect(floating?.gapMm).toBeCloseTo(1, 3);
    expect(['leg_left', 'leg_right']).toContain(floating?.nearestBody);
  });

  it('腳拉長 1.5 mm 接進身體後就沒有浮空', () => {
    const fixed = topper(51).map((p) =>
      p.name.startsWith('leg') ? { ...p, triangles: boxTriangles([18, 17, 50.5], [-29, p.name === 'leg_left' ? -14 : 9, 1]) } : p,
    );
    const report = findFloatingBodies(fixed);
    expect(report.floating).toEqual([]);
    expect(report.bodyCount).toBe(1);
  });

  it('被包住的實體不算浮空', () => {
    const report = findFloatingBodies([
      part('shell', [20, 20, 20], [0, 0, 0]),
      part('core', [4, 4, 4], [8, 8, 8]),
    ]);
    expect(report.floating).toEqual([]);
  });

  it('包在兩個重疊方塊交集裡的實體也不算浮空（奇偶測試要逐殼做）', () => {
    // 整塊實體一起數交點的話，點同時在兩個殼內 → 奇＋奇＝偶 → 誤判成在外面。
    // 真實的生日插牌就是這樣把被包住的零件報成浮空。
    const report = findFloatingBodies([
      part('left', [20, 20, 20], [0, 0, 0]),
      part('right', [20, 20, 20], [10, 0, 0]),
      part('core', [4, 4, 4], [12, 8, 8]),
    ]);
    expect(report.floating).toEqual([]);
  });

  it('最近實體優先指向站在板子上的那塊，不是旁邊另一塊浮空的', () => {
    const report = findFloatingBodies([
      part('ground', [10, 10, 10], [0, 0, 0]),
      part('floater', [10, 10, 5], [0, 0, 11]), // 離 ground 1 mm
      part('neighbour', [10, 10, 5], [0, 10.2, 11]), // 離 floater 0.2 mm，自己也浮空
    ]);
    const floater = report.floating.find((body) => body.name === 'floater');
    expect(floater?.nearestBody).toBe('ground');
    expect(floater?.gapMm).toBeCloseTo(1, 3);
  });

  it('修飾體、挖除體這種不會印出來的零件不算', () => {
    const report = findFloatingBodies([
      part('base', [20, 20, 5], [0, 0, 0]),
      part('infill_zone', [5, 5, 5], [5, 5, 30], 'modifier_part'),
      part('hole', [5, 5, 5], [5, 5, 40], 'negative_part'),
    ]);
    expect(report.floating).toEqual([]);
  });

  it('STL 沒有零件邊界也抓得到：同一包三角形依共用頂點拆殼', () => {
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

describe('analysePrintability 的浮空發現', () => {
  it('窄縫判為建模沒接上：blocker，而且不建議開支撐', () => {
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
    // blocker 排在最前面。
    expect(report.findings[0]?.code).toBe('floating-part');
  });

  it('寬縫是真的懸空：建議支撐', () => {
    const parts = [part('base', [10, 10, 10], [0, 0, 0]), part('cloud', [10, 10, 10], [0, 0, 30])];
    const report = analysePrintability(
      parts.flatMap((p) => p.triangles),
      undefined,
      parts,
    );
    const finding = report.findings.find((f) => f.code === 'floating-part');
    expect(finding?.relatedParameters).toContain('enable_support');
  });

  it('單一實體的模型沒有浮空發現', () => {
    const report = analysePrintability(boxTriangles([20, 20, 20]));
    expect(report.floatingBodies).toEqual([]);
    expect(report.findings.map((f) => f.code)).not.toContain('floating-part');
  });
});

describe('幾何小工具', () => {
  it('splitShells 依共用頂點分殼', () => {
    const shells = splitShells([...boxTriangles([1, 1, 1]), ...boxTriangles([1, 1, 1], [5, 0, 0])]);
    expect(shells).toHaveLength(2);
    expect(shells.map((s) => s.length)).toEqual([12, 12]);
  });

  it('pointInsideMesh 在方塊稜線對齊的位置也不會數錯', () => {
    const box = boxTriangles([10, 10, 10]);
    expect(pointInsideMesh({ x: 5, y: 5, z: 5 }, box)).toBe(true);
    expect(pointInsideMesh({ x: 0.5, y: 0.5, z: 0.5 }, box)).toBe(true);
    expect(pointInsideMesh({ x: 15, y: 5, z: 5 }, box)).toBe(false);
    expect(pointInsideMesh({ x: 5, y: 5, z: -1 }, box)).toBe(false);
  });
});
