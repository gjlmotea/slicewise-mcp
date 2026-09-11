import type { BoundingBox, ModelInspection, Vec3 } from '../contracts.js';

/**
 * STL 解析與幾何量測。
 *
 * 支援 binary 與 ASCII 兩種格式。STL 沒有單位資訊，一律以 mm 解讀 ——
 * 這是 3D 列印生態的實質約定，也是 BambuStudio 匯入時的假設。
 */

export type Triangle = {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  /** 檔案宣告的法向量；許多匯出器寫 0,0,0，所以計算一律用頂點自算。 */
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
 * 判斷 binary 還是 ASCII。
 *
 * 不能只看開頭是不是 "solid" —— binary STL 的 80 bytes 標頭也可能剛好以 solid 開頭。
 * 唯一可靠的判準是：binary 的長度必定等於 84 + 50 × 三角形數。
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
        throw new StlParseError(`ASCII STL 的 vertex 行格式不正確：${line}`);
      }
      vertices.push({ x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 });
      continue;
    }

    if (line.startsWith('endfacet')) {
      const [a, b, c] = vertices;
      if (a === undefined || b === undefined || c === undefined) {
        throw new StlParseError('ASCII STL 有 facet 的頂點少於三個');
      }
      triangles.push({ a, b, c, declaredNormal });
      vertices = [];
    }
  }

  if (triangles.length === 0) {
    throw new StlParseError('沒有解析到任何三角形；檔案可能不是 STL 或已損毀');
  }

  return triangles;
}

// ── 幾何量測 ────────────────────────────────────────────────────────────

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

/** 由頂點計算的單位法向量；退化三角形回傳 undefined。 */
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
 * 以帶號四面體體積求和計算封閉體積。
 *
 * 對非封閉網格這個值沒有物理意義，所以 `inspectModel` 只在 `closed` 為真時才對外宣稱是體積。
 */
export function signedVolume(triangles: readonly Triangle[]): number {
  let total = 0;
  for (const { a, b, c } of triangles) {
    total += dot(a, cross(b, c)) / 6;
  }
  return Math.abs(total);
}

/**
 * 以邊配對判斷網格是否封閉。
 *
 * 頂點座標用浮點值做 key 會因為匯出精度而配不起來，所以先量化到 1e-5 mm。
 * 這個容差遠小於任何列印特徵，不會把真正的破洞黏起來。
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
      // 無向邊：小的在前，這樣正反向會落在同一個 key。
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
