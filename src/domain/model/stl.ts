import type { BoundingBox, ModelInspection, Vec3 } from '../contracts.js';

/**
 * STL parsing and geometry measurement.
 *
 * Supports both binary and ASCII formats. STL carries no unit information and is always read
 * as mm — that is the de facto convention of the 3D printing ecosystem, and also what
 * BambuStudio assumes on import.
 */

export type Triangle = {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  /** The normal declared in the file; many exporters write 0,0,0, so calculations always derive it from the vertices. */
  readonly declaredNormal: Vec3;
};

export class StlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StlParseError';
  }
}

const BINARY_HEADER_BYTES = 84;
const BINARY_TRIANGLE_BYTES = 50;

/**
 * Decides between binary and ASCII.
 *
 * Checking whether it starts with "solid" is not enough — the 80-byte header of a binary STL
 * may happen to start with "solid" too. The only reliable test: a binary file's length is
 * always exactly 84 + 50 × triangle count.
 */
export function isBinaryStl(buffer: Buffer): boolean {
  if (buffer.length < BINARY_HEADER_BYTES) return false;
  const declared = buffer.readUInt32LE(80);
  return buffer.length === BINARY_HEADER_BYTES + declared * BINARY_TRIANGLE_BYTES;
}

export function parseStl(buffer: Buffer): readonly Triangle[] {
  return isBinaryStl(buffer) ? parseBinaryStl(buffer) : parseAsciiStl(buffer.toString('utf8'));
}

function parseBinaryStl(buffer: Buffer): readonly Triangle[] {
  const count = buffer.readUInt32LE(80);
  const triangles: Triangle[] = [];

  for (let index = 0; index < count; index += 1) {
    const base = BINARY_HEADER_BYTES + index * BINARY_TRIANGLE_BYTES;
    triangles.push({
      declaredNormal: readVec(buffer, base),
      a: readVec(buffer, base + 12),
      b: readVec(buffer, base + 24),
      c: readVec(buffer, base + 36),
    });
  }

  return triangles;
}

function readVec(buffer: Buffer, offset: number): Vec3 {
  return {
    x: buffer.readFloatLE(offset),
    y: buffer.readFloatLE(offset + 4),
    z: buffer.readFloatLE(offset + 8),
  };
}

function parseAsciiStl(text: string): readonly Triangle[] {
  const triangles: Triangle[] = [];
  const numbers = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

  let declaredNormal: Vec3 = { x: 0, y: 0, z: 0 };
  let vertices: Vec3[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (line.startsWith('facet normal')) {
      const parts = line.match(numbers)?.map(Number.parseFloat) ?? [];
      declaredNormal =
        parts.length >= 3
          ? { x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 }
          : { x: 0, y: 0, z: 0 };
      vertices = [];
      continue;
    }

    if (line.startsWith('vertex')) {
      const parts = line.match(numbers)?.map(Number.parseFloat) ?? [];
      if (parts.length < 3) {
        throw new StlParseError(`Malformed vertex line in ASCII STL: ${line}`);
      }
      vertices.push({ x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 });
      continue;
    }

    if (line.startsWith('endfacet')) {
      const [a, b, c] = vertices;
      if (a === undefined || b === undefined || c === undefined) {
        throw new StlParseError('ASCII STL has a facet with fewer than three vertices');
      }
      triangles.push({ a, b, c, declaredNormal });
      vertices = [];
    }
  }

  if (triangles.length === 0) {
    throw new StlParseError('No triangles were parsed; the file may not be an STL or may be corrupted');
  }

  return triangles;
}

// ── Geometry measurement ────────────────────────────────────────────────

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

/** Unit normal computed from the vertices; undefined for a degenerate triangle. */
export function faceNormal(triangle: Triangle): Vec3 | undefined {
  const normal = cross(subtract(triangle.b, triangle.a), subtract(triangle.c, triangle.a));
  const magnitude = length(normal);
  if (magnitude <= Number.EPSILON) return undefined;
  return { x: normal.x / magnitude, y: normal.y / magnitude, z: normal.z / magnitude };
}

export function triangleArea(triangle: Triangle): number {
  return (
    length(cross(subtract(triangle.b, triangle.a), subtract(triangle.c, triangle.a))) / 2
  );
}

export function boundingBox(triangles: readonly Triangle[]): BoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const triangle of triangles) {
    for (const vertex of [triangle.a, triangle.b, triangle.c]) {
      if (vertex.x < minX) minX = vertex.x;
      if (vertex.y < minY) minY = vertex.y;
      if (vertex.z < minZ) minZ = vertex.z;
      if (vertex.x > maxX) maxX = vertex.x;
      if (vertex.y > maxY) maxY = vertex.y;
      if (vertex.z > maxZ) maxZ = vertex.z;
    }
  }

  const min = { x: minX, y: minY, z: minZ };
  const max = { x: maxX, y: maxY, z: maxZ };
  return { min, max, size: subtract(max, min) };
}

/**
 * Computes the enclosed volume by summing signed tetrahedron volumes.
 *
 * For a mesh that is not closed this value has no physical meaning, so `inspectModel` only
 * presents it as a volume when `closed` is true.
 */
export function signedVolume(triangles: readonly Triangle[]): number {
  let total = 0;
  for (const { a, b, c } of triangles) {
    total += dot(a, cross(b, c)) / 6;
  }
  return Math.abs(total);
}

/**
 * Decides whether a mesh is closed by pairing up edges.
 *
 * Using raw float coordinates as keys fails to pair because of export precision, so they are
 * quantised to 1e-5 mm first. That tolerance is far smaller than any printable feature, so it
 * will not glue a real hole shut.
 */
const QUANTUM = 1e5;

function vertexKey(v: Vec3): string {
  return `${Math.round(v.x * QUANTUM)},${Math.round(v.y * QUANTUM)},${Math.round(v.z * QUANTUM)}`;
}

export function countOpenEdges(triangles: readonly Triangle[]): number {
  const edges = new Map<string, number>();

  for (const triangle of triangles) {
    const keys = [vertexKey(triangle.a), vertexKey(triangle.b), vertexKey(triangle.c)];
    for (let index = 0; index < 3; index += 1) {
      const from = keys[index] ?? '';
      const to = keys[(index + 1) % 3] ?? '';
      // Undirected edge: smaller key first, so both directions land on the same key.
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }

  let open = 0;
  for (const count of edges.values()) {
    if (count !== 2) open += 1;
  }
  return open;
}

export function inspectModel(triangles: readonly Triangle[]): ModelInspection {
  let degenerate = 0;
  let surfaceArea = 0;

  for (const triangle of triangles) {
    const area = triangleArea(triangle);
    if (area <= 1e-9) degenerate += 1;
    else surfaceArea += area;
  }

  const openEdges = countOpenEdges(triangles);

  return {
    triangleCount: triangles.length,
    boundingBox: boundingBox(triangles),
    volumeMm3: signedVolume(triangles),
    surfaceAreaMm2: surfaceArea,
    closed: openEdges === 0,
    degenerateTriangles: degenerate,
    openEdges,
  };
}
