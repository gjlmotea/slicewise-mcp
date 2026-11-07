import type { Vec3 } from '../contracts.js';

/**
 * Indexed mesh. 3MF uses "vertex list + triangle indices", unlike STL where every triangle
 * stores its own three vertices, so this is a separate type rather than a reuse of `stl.ts`'s
 * `Triangle`.
 */
export type IndexedMesh = {
  readonly vertices: readonly Vec3[];
  readonly triangles: readonly (readonly [number, number, number])[];
};

export type PrimitiveShape =
  | { readonly kind: 'box'; readonly size: Vec3 }
  | { readonly kind: 'cylinder'; readonly diameter: number; readonly height: number; readonly segments?: number }
  | { readonly kind: 'sphere'; readonly diameter: number; readonly segments?: number };

const DEFAULT_SEGMENTS = 32;
const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 128;

/**
 * Generates a primitive shape centred on `center`.
 *
 * The position is baked straight into the vertex coordinates and the component transform is
 * the identity. That way "coordinates in the file" equal "actual position", and debugging needs
 * no conversion between two matrices; if the user later moves the part in Bambu Studio, Studio
 * stacks its own matrix on top, which is unaffected.
 */
export function buildPrimitive(shape: PrimitiveShape, center: Vec3 = { x: 0, y: 0, z: 0 }): IndexedMesh {
  switch (shape.kind) {
    case 'box':
      return boxMesh(shape.size, center);
    case 'cylinder':
      return cylinderMesh(shape.diameter, shape.height, clampSegments(shape.segments), center);
    case 'sphere':
      return sphereMesh(shape.diameter, clampSegments(shape.segments), center);
  }
}

function clampSegments(segments: number | undefined): number {
  if (segments === undefined) return DEFAULT_SEGMENTS;
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(segments)));
}

function boxMesh(size: Vec3, c: Vec3): IndexedMesh {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;

  const vertices: Vec3[] = [
    { x: c.x - hx, y: c.y - hy, z: c.z - hz },
    { x: c.x + hx, y: c.y - hy, z: c.z - hz },
    { x: c.x + hx, y: c.y + hy, z: c.z - hz },
    { x: c.x - hx, y: c.y + hy, z: c.z - hz },
    { x: c.x - hx, y: c.y - hy, z: c.z + hz },
    { x: c.x + hx, y: c.y - hy, z: c.z + hz },
    { x: c.x + hx, y: c.y + hy, z: c.z + hz },
    { x: c.x - hx, y: c.y + hy, z: c.z + hz },
  ];

  // Winding order keeps normals pointing outward; checked by hand to match the cube in tests/fixtures/geometry.ts.
  const triangles: (readonly [number, number, number])[] = [
    [0, 2, 1], [0, 3, 2], // -Z
    [4, 5, 6], [4, 6, 7], // +Z
    [0, 1, 5], [0, 5, 4], // -Y
    [1, 2, 6], [1, 6, 5], // +X
    [2, 3, 7], [2, 7, 6], // +Y
    [3, 0, 4], [3, 4, 7], // -X
  ];

  return { vertices, triangles };
}

function cylinderMesh(diameter: number, height: number, segments: number, c: Vec3): IndexedMesh {
  const radius = diameter / 2;
  const hz = height / 2;
  const vertices: Vec3[] = [];
  const triangles: (readonly [number, number, number])[] = [];

  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const x = c.x + radius * Math.cos(angle);
    const y = c.y + radius * Math.sin(angle);
    vertices.push({ x, y, z: c.z - hz }); // bottom ring: even index 2i
    vertices.push({ x, y, z: c.z + hz }); // top ring: odd index 2i+1
  }

  const bottomCentre = vertices.length;
  vertices.push({ x: c.x, y: c.y, z: c.z - hz });
  const topCentre = vertices.length;
  vertices.push({ x: c.x, y: c.y, z: c.z + hz });

  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    const b0 = i * 2;
    const t0 = i * 2 + 1;
    const b1 = next * 2;
    const t1 = next * 2 + 1;

    triangles.push([b0, b1, t1], [b0, t1, t0]); // side
    triangles.push([bottomCentre, b1, b0]); // bottom cap, normal points -Z
    triangles.push([topCentre, t0, t1]); // top cap, normal points +Z
  }

  return { vertices, triangles };
}

function sphereMesh(diameter: number, segments: number, c: Vec3): IndexedMesh {
  const radius = diameter / 2;
  const rings = Math.max(4, Math.round(segments / 2));
  const vertices: Vec3[] = [];
  const triangles: (readonly [number, number, number])[] = [];

  // The poles are handled separately to avoid degenerate triangles.
  const north = 0;
  vertices.push({ x: c.x, y: c.y, z: c.z + radius });

  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    const z = radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    for (let i = 0; i < segments; i += 1) {
      const theta = (i / segments) * Math.PI * 2;
      vertices.push({
        x: c.x + r * Math.cos(theta),
        y: c.y + r * Math.sin(theta),
        z: c.z + z,
      });
    }
  }

  const south = vertices.length;
  vertices.push({ x: c.x, y: c.y, z: c.z - radius });

  const ringStart = (ring: number): number => 1 + (ring - 1) * segments;

  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    triangles.push([north, ringStart(1) + i, ringStart(1) + next]);
  }

  for (let ring = 1; ring < rings - 1; ring += 1) {
    for (let i = 0; i < segments; i += 1) {
      const next = (i + 1) % segments;
      const a = ringStart(ring) + i;
      const b = ringStart(ring) + next;
      const cIdx = ringStart(ring + 1) + i;
      const d = ringStart(ring + 1) + next;
      triangles.push([a, cIdx, d], [a, d, b]);
    }
  }

  const last = ringStart(rings - 1);
  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    triangles.push([south, last + next, last + i]);
  }

  return { vertices, triangles };
}

/** Bounds of an indexed mesh, used for reporting and collision checks. */
export function meshBounds(mesh: IndexedMesh): { readonly min: Vec3; readonly max: Vec3 } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const v of mesh.vertices) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
    if (v.z > maxZ) maxZ = v.z;
  }

  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}
