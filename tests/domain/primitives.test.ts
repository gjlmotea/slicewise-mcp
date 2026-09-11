import { describe, expect, it } from 'vitest';

import { buildPrimitive, meshBounds, type IndexedMesh } from '../../src/domain/model/primitives.js';
import { buildZip } from '../../src/domain/slicing/zip-writer.js';
import { readZipDirectory, readZipEntry } from '../../src/domain/slicing/zip.js';

/**
 * 索引式網格的封閉性檢查：每條無向邊都必須恰好被兩個三角形共用。
 * 不封閉的網格丟給切片器會產生無法預期的內外判定。
 */
function openEdgeCount(mesh: IndexedMesh): number {
  const edges = new Map<string, number>();
  for (const [a, b, c] of mesh.triangles) {
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()].filter((count) => count !== 2).length;
}

describe('buildPrimitive', () => {
  it('方塊是封閉的', () => {
    expect(openEdgeCount(buildPrimitive({ kind: 'box', size: { x: 10, y: 20, z: 30 } }))).toBe(0);
  });

  it('圓柱是封閉的', () => {
    expect(openEdgeCount(buildPrimitive({ kind: 'cylinder', diameter: 8, height: 20 }))).toBe(0);
  });

  it('球是封閉的', () => {
    expect(openEdgeCount(buildPrimitive({ kind: 'sphere', diameter: 12 }))).toBe(0);
  });

  it('方塊的尺寸與中心正確', () => {
    const bounds = meshBounds(
      buildPrimitive({ kind: 'box', size: { x: 10, y: 20, z: 30 } }, { x: 5, y: 5, z: 15 }),
    );
    expect(bounds.min).toEqual({ x: 0, y: -5, z: 0 });
    expect(bounds.max).toEqual({ x: 10, y: 15, z: 30 });
  });

  it('圓柱的外框等於直徑與高度', () => {
    const bounds = meshBounds(buildPrimitive({ kind: 'cylinder', diameter: 10, height: 20 }));
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(20, 6);
    // 多邊形逼近的圓，寬度不會超過直徑。
    expect(bounds.max.x - bounds.min.x).toBeLessThanOrEqual(10 + 1e-9);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(9.9);
  });

  it('球的外框等於直徑', () => {
    const bounds = meshBounds(buildPrimitive({ kind: 'sphere', diameter: 12, segments: 64 }));
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(12, 6);
  });

  it('段數會被夾在安全範圍內', () => {
    // 太少會變成多面體，太多會讓 3MF 爆掉。
    const coarse = buildPrimitive({ kind: 'cylinder', diameter: 10, height: 5, segments: 2 });
    const fine = buildPrimitive({ kind: 'cylinder', diameter: 10, height: 5, segments: 999 });
    expect(coarse.vertices.length).toBeGreaterThanOrEqual(8 * 2);
    expect(fine.vertices.length).toBeLessThanOrEqual(128 * 2 + 2);
    expect(openEdgeCount(coarse)).toBe(0);
    expect(openEdgeCount(fine)).toBe(0);
  });
});

describe('buildZip', () => {
  it('寫出的內容自己讀得回來', () => {
    const buffer = buildZip([
      { name: 'a.txt', content: 'hello' },
      { name: 'nested/b.xml', content: '<x/>'.repeat(500) },
    ]);
    expect(readZipEntry(buffer, 'a.txt')?.toString('utf8')).toBe('hello');
    expect(readZipEntry(buffer, 'nested/b.xml')?.toString('utf8')).toBe('<x/>'.repeat(500));
  });

  it('可壓縮的內容用 deflate，壓不小的用 stored', () => {
    const buffer = buildZip([
      { name: 'tiny.txt', content: 'x' },
      { name: 'repetitive.txt', content: 'x'.repeat(5000) },
    ]);
    const entries = readZipDirectory(buffer);
    expect(entries.find((entry) => entry.name === 'tiny.txt')?.compressionMethod).toBe(0);
    expect(entries.find((entry) => entry.name === 'repetitive.txt')?.compressionMethod).toBe(8);
  });

  it('相同輸入產生相同位元組', () => {
    // 時間戳固定為 0，這樣輸出可重現、可比對雜湊。
    const make = () => buildZip([{ name: 'a.txt', content: 'hello' }]);
    expect(make().equals(make())).toBe(true);
  });
});
