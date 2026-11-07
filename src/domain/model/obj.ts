import type { Vec3 } from '../contracts.js';
import type { Triangle } from './stl.js';
import type { MeshPart } from './threemf-reader.js';

/**
 * Wavefront OBJ 解析。
 *
 * 為什麼要吃 OBJ：Tinkercad 匯出「帶顏色」的模型只有 OBJ（配 .mtl），而 Bambu Studio
 * 匯入 OBJ 時會跳出顏色對應視窗、把每個材質分配到一個耗材槽。使用者實際丟進 Studio 的
 * 往往就是這個檔，不先轉成 STL 就該能檢查。
 *
 * 零件邊界：OBJ 用 `o`（物件）與 `g`（群組）分段。Tinkercad 每個基本形狀各自一個 `o`，
 * 裡面再包一個 `g` 與 `usemtl`。以 `o` 為主、沒有 `o` 才退回 `g`，兩者都沒有就整檔一個零件。
 *
 * 單位：OBJ 跟 STL 一樣沒有單位資訊，一律以 mm 解讀（Bambu Studio 匯入時也是這樣假設）。
 */

export class ObjParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjParseError';
  }
}

/**
 * 判斷內容是不是 OBJ。
 *
 * 看前 64 KB 有沒有 `v x y z` 頂點行與 `f` 面行。ASCII STL 的頂點行是 `vertex`，
 * 這個 pattern 要求 `v` 後面直接接空白，所以不會誤認。
 */
export function looksLikeObj(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 65536).toString('utf8');
  if (/^\s*solid\b/.test(head) && /\bfacet\b/.test(head)) return false;
  return /^v[ \t]+[-+.\d]/m.test(head) && /^f[ \t]+-?\d/m.test(head);
}

/** OBJ 的面索引從 1 開始；負數代表從目前已讀到的頂點往回數。 */
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
          throw new ObjParseError(`OBJ 的頂點行格式不正確：${line}`);
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
        // 有 `o` 的檔案以物件為零件；只有 `g` 的檔案（Blender 舊版匯出常見）才以群組為零件。
        const key = (usesObjects ? objectName : groupName) ?? objectName ?? displayName;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = { triangles: [], material };
          buckets.set(key, bucket);
          order.push(key);
        }
        // 多邊形面以扇形三角化。OBJ 規格要求面是凸的，扇形對凸多邊形是正確的。
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
        // vt、vn、mtllib、s、l 等與幾何封閉體無關，略過。
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
        ? `OBJ 有 ${badFaces} 個面的頂點索引無效，沒有解析到任何三角形；檔案可能已損毀`
        : '沒有解析到任何三角形；檔案可能不是 OBJ 或只有點雲',
    );
  }

  return parts;
}
