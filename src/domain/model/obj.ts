import type { Vec3 } from '../contracts.js';
import type { Triangle } from './stl.js';
import type { MeshPart } from './threemf-reader.js';

/**
 * Wavefront OBJ parsing.
 *
 * Why accept OBJ: Tinkercad exports a model "with colours" only as OBJ (plus .mtl), and when
 * Bambu Studio imports an OBJ it pops up a colour-mapping dialog that assigns each material to a
 * filament slot. That is often the very file users drop into Studio, so it should be checkable
 * without converting it to STL first.
 *
 * Part boundaries: OBJ splits into sections with `o` (object) and `g` (group). Tinkercad gives
 * each primitive its own `o`, wrapping a `g` and a `usemtl` inside. `o` takes priority, `g` is
 * the fallback when there is no `o`, and with neither the whole file is one part.
 *
 * Units: like STL, OBJ carries no unit information and is always read as mm (Bambu Studio
 * assumes the same on import).
 */

export class ObjParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjParseError';
  }
}

/**
 * Decides whether the content is OBJ.
 *
 * Looks for `v x y z` vertex lines and `f` face lines in the first 64 KB. ASCII STL vertex
 * lines read `vertex`, and this pattern requires whitespace right after the `v`, so it cannot
 * mistake one for the other.
 */
export function looksLikeObj(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 65536).toString('utf8');
  if (/^\s*solid\b/.test(head) && /\bfacet\b/.test(head)) return false;
  return /^v[ \t]+[-+.\d]/m.test(head) && /^f[ \t]+-?\d/m.test(head);
}

/** OBJ face indices start at 1; a negative index counts back from the vertices read so far. */
function resolveIndex(token: string, vertexCount: number): number | undefined {
  const raw = Number.parseInt(token.split('/')[0] ?? '', 10);
  if (!Number.isFinite(raw) || raw === 0) return undefined;
  const index = raw > 0 ? raw - 1 : vertexCount + raw;
  return index >= 0 && index < vertexCount ? index : undefined;
}

export function parseObj(text: string, displayName = 'model'): readonly MeshPart[] {
  const vertices: Vec3[] = [];
  const order: string[] = [];
  const buckets = new Map<string, { triangles: Triangle[]; material: string | undefined }>();

  let objectName: string | undefined;
  let groupName: string | undefined;
  let material: string | undefined;
  let usesObjects = false;
  let badFaces = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const [keyword, ...rest] = line.split(/\s+/);

    switch (keyword) {
      case 'v': {
        const [x, y, z] = rest.slice(0, 3).map(Number.parseFloat);
        if (x === undefined || y === undefined || z === undefined || [x, y, z].some(Number.isNaN)) {
          throw new ObjParseError(`Malformed vertex line in OBJ: ${line}`);
        }
        vertices.push({ x, y, z });
        break;
      }
      case 'o':
        usesObjects = true;
        objectName = rest.join(' ') || undefined;
        groupName = undefined;
        break;
      case 'g':
        groupName = rest.join(' ') || undefined;
        break;
      case 'usemtl':
        material = rest.join(' ') || undefined;
        break;
      case 'f': {
        const indices = rest.map((token) => resolveIndex(token, vertices.length));
        if (indices.length < 3 || indices.some((index) => index === undefined)) {
          badFaces += 1;
          break;
        }
        // Files with `o` use objects as parts; only files with just `g` (common in older Blender exports) use groups as parts.
        const key = (usesObjects ? objectName : groupName) ?? objectName ?? displayName;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = { triangles: [], material };
          buckets.set(key, bucket);
          order.push(key);
        }
        // Polygon faces are fan-triangulated. The OBJ spec requires convex faces, and a fan is correct for convex polygons.
        const resolved = indices as number[];
        const first = vertices[resolved[0] ?? 0];
        for (let k = 1; k + 1 < resolved.length; k += 1) {
          const b = vertices[resolved[k] ?? 0];
          const c = vertices[resolved[k + 1] ?? 0];
          if (first === undefined || b === undefined || c === undefined) continue;
          bucket.triangles.push({ a: first, b, c, declaredNormal: { x: 0, y: 0, z: 0 } });
        }
        break;
      }
      default:
        // vt, vn, mtllib, s, l and the like have nothing to do with the closed solid geometry; skip them.
        break;
    }
  }

  const parts: MeshPart[] = order.flatMap((key, index) => {
    const bucket = buckets.get(key);
    if (bucket === undefined || bucket.triangles.length === 0) return [];
    return [
      {
        name: key,
        partId: String(index + 1),
        extruder: undefined,
        ...(bucket.material === undefined ? {} : { material: bucket.material }),
        triangles: bucket.triangles,
      },
    ];
  });

  if (parts.length === 0) {
    throw new ObjParseError(
      badFaces > 0
        ? `OBJ has ${badFaces} face(s) with invalid vertex indices and no triangles were parsed; the file may be corrupted`
        : 'No triangles were parsed; the file may not be an OBJ or may contain only a point cloud',
    );
  }

  return parts;
}
