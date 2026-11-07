import type { Triangle } from '../../src/domain/model/stl.js';

type Point = readonly [number, number, number];

function vec(point: Point): { x: number; y: number; z: number } {
  return { x: point[0], y: point[1], z: point[2] };
}

/**
 * Produces an axis-aligned box with all normals pointing outward.
 *
 * The winding was checked by hand: cross(b-a, c-a) of every face points outward,
 * so signedVolume yields the correct volume rather than 0.
 */
export function boxTriangles(
  size: Point = [20, 20, 20],
  origin: Point = [0, 0, 0],
): readonly Triangle[] {
  const [sx, sy, sz] = size;
  const [ox, oy, oz] = origin;

  const v: readonly Point[] = [
    [ox, oy, oz],
    [ox + sx, oy, oz],
    [ox + sx, oy + sy, oz],
    [ox, oy + sy, oz],
    [ox, oy, oz + sz],
    [ox + sx, oy, oz + sz],
    [ox + sx, oy + sy, oz + sz],
    [ox, oy + sy, oz + sz],
  ];

  const faces: readonly (readonly [number, number, number])[] = [
    [0, 2, 1], [0, 3, 2], // bottom -Z
    [4, 5, 6], [4, 6, 7], // top +Z
    [0, 1, 5], [0, 5, 4], // front -Y
    [1, 2, 6], [1, 6, 5], // right +X
    [2, 3, 7], [2, 7, 6], // back +Y
    [3, 0, 4], [3, 4, 7], // left -X
  ];

  return faces.map(([a, b, c]) => ({
    a: vec(v[a] as Point),
    b: vec(v[b] as Point),
    c: vec(v[c] as Point),
    declaredNormal: { x: 0, y: 0, z: 0 },
  }));
}

/** Writes triangles as a binary STL. */
export function toBinaryStl(triangles: readonly Triangle[]): Buffer {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write('bambu-mcp test fixture', 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);

  triangles.forEach((triangle, index) => {
    const base = 84 + index * 50;
    const values = [
      triangle.declaredNormal,
      triangle.a,
      triangle.b,
      triangle.c,
    ];
    values.forEach((point, slot) => {
      buffer.writeFloatLE(point.x, base + slot * 12);
      buffer.writeFloatLE(point.y, base + slot * 12 + 4);
      buffer.writeFloatLE(point.z, base + slot * 12 + 8);
    });
  });

  return buffer;
}

/** Writes triangles as an ASCII STL. */
export function toAsciiStl(triangles: readonly Triangle[]): Buffer {
  const lines = ['solid fixture'];
  for (const triangle of triangles) {
    lines.push('facet normal 0 0 0', '  outer loop');
    for (const point of [triangle.a, triangle.b, triangle.c]) {
      lines.push(`    vertex ${point.x} ${point.y} ${point.z}`);
    }
    lines.push('  endloop', 'endfacet');
  }
  lines.push('endsolid fixture');
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/**
 * A T-shaped cantilever: the top beam sticks out on both sides with nothing underneath.
 * Used to verify that overhang detection catches downward-facing faces that are not on the bed.
 */
export function overhangingTriangles(): readonly Triangle[] {
  return [
    ...boxTriangles([4, 4, 10], [8, 8, 0]), // upright post
    ...boxTriangles([20, 4, 4], [0, 8, 10]), // cross beam
  ];
}
