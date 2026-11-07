import { describe, expect, it } from 'vitest';

import { buildPrimitive, meshBounds, type IndexedMesh } from '../../src/domain/model/primitives.js';
import { buildZip } from '../../src/domain/slicing/zip-writer.js';
import { readZipDirectory, readZipEntry } from '../../src/domain/slicing/zip.js';

/**
 * Closedness check for an indexed mesh: every undirected edge must be shared by exactly two triangles.
 * A mesh that is not closed gives the slicer unpredictable inside/outside decisions.
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
  it('box is closed', () => {
    expect(openEdgeCount(buildPrimitive({ kind: 'box', size: { x: 10, y: 20, z: 30 } }))).toBe(0);
  });

  it('cylinder is closed', () => {
    expect(openEdgeCount(buildPrimitive({ kind: 'cylinder', diameter: 8, height: 20 }))).toBe(0);
  });

  it('sphere is closed', () => {
    expect(openEdgeCount(buildPrimitive({ kind: 'sphere', diameter: 12 }))).toBe(0);
  });

  it('box has the correct size and centre', () => {
    const bounds = meshBounds(
      buildPrimitive({ kind: 'box', size: { x: 10, y: 20, z: 30 } }, { x: 5, y: 5, z: 15 }),
    );
    expect(bounds.min).toEqual({ x: 0, y: -5, z: 0 });
    expect(bounds.max).toEqual({ x: 10, y: 15, z: 30 });
  });

  it('cylinder bounds equal its diameter and height', () => {
    const bounds = meshBounds(buildPrimitive({ kind: 'cylinder', diameter: 10, height: 20 }));
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(20, 6);
    // A polygon approximating a circle is never wider than the diameter.
    expect(bounds.max.x - bounds.min.x).toBeLessThanOrEqual(10 + 1e-9);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(9.9);
  });

  it('sphere bounds equal its diameter', () => {
    const bounds = meshBounds(buildPrimitive({ kind: 'sphere', diameter: 12, segments: 64 }));
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(12, 6);
  });

  it('clamps the segment count to a safe range', () => {
    // Too few turns it into a faceted polyhedron, too many blows up the 3MF.
    const coarse = buildPrimitive({ kind: 'cylinder', diameter: 10, height: 5, segments: 2 });
    const fine = buildPrimitive({ kind: 'cylinder', diameter: 10, height: 5, segments: 999 });
    expect(coarse.vertices.length).toBeGreaterThanOrEqual(8 * 2);
    expect(fine.vertices.length).toBeLessThanOrEqual(128 * 2 + 2);
    expect(openEdgeCount(coarse)).toBe(0);
    expect(openEdgeCount(fine)).toBe(0);
  });
});

describe('buildZip', () => {
  it('reads back what it wrote', () => {
    const buffer = buildZip([
      { name: 'a.txt', content: 'hello' },
      { name: 'nested/b.xml', content: '<x/>'.repeat(500) },
    ]);
    expect(readZipEntry(buffer, 'a.txt')?.toString('utf8')).toBe('hello');
    expect(readZipEntry(buffer, 'nested/b.xml')?.toString('utf8')).toBe('<x/>'.repeat(500));
  });

  it('uses deflate for compressible content and stored for content that does not shrink', () => {
    const buffer = buildZip([
      { name: 'tiny.txt', content: 'x' },
      { name: 'repetitive.txt', content: 'x'.repeat(5000) },
    ]);
    const entries = readZipDirectory(buffer);
    expect(entries.find((entry) => entry.name === 'tiny.txt')?.compressionMethod).toBe(0);
    expect(entries.find((entry) => entry.name === 'repetitive.txt')?.compressionMethod).toBe(8);
  });

  it('produces identical bytes for identical input', () => {
    // Timestamps are fixed at 0 so output is reproducible and hashes can be compared.
    const make = () => buildZip([{ name: 'a.txt', content: 'hello' }]);
    expect(make().equals(make())).toBe(true);
  });
});
