import type { Vec3 } from '../contracts.js';
import { readZipDirectory, readZipEntry } from '../slicing/zip.js';
import type { Triangle } from './stl.js';

/**
 * 從 3MF 讀出實際幾何。
 *
 * `threemf.ts` 負責「寫」，這一支負責「讀」。分開是因為兩邊的難處不同：
 * 寫的時候結構由我們決定，讀的時候要面對別人產生的檔案 —— 尤其是 Bambu／MakerWorld
 * 那種把網格拆進 `3D/Objects/*.model`、再用 production extension 的 `p:path` 從根檔案
 * 引用回來的形式。只讀根檔案會什麼都拿不到。
 *
 * 座標一律解算到「擺在列印板上的位置」：component 的 transform 與 build item 的 transform
 * 都會套用。這樣量出來的數字跟使用者在 Studio 裡看到的是同一套。
 */

export class ThreeMfReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreeMfReadError';
  }
}

/** 3MF 的一個零件：一組已經解算到世界座標的三角形。 */
export type MeshPart = {
  /** 顯示名稱。取自 model_settings.config，沒有就用 object id 兜。 */
  readonly name: string;
  /** 這個零件在 3MF 裡的 part id（來自 model_settings.config 的順序）。 */
  readonly partId: string;
  /** 指派的擠出頭編號；沒有多色資訊時為 undefined。 */
  readonly extruder: string | undefined;
  readonly triangles: readonly Triangle[];
};

/**
 * 3MF 的 transform 是 12 個數字，列主序的 4×3。
 * 套用方式是列向量右乘：`p' = p · M + t`，其中 t 是最後三個數。
 * 寫錯成行向量的話平移會跑到別的軸上，而且不會報錯 —— 只會安靜地量出錯誤的距離。
 */
type Transform = readonly number[];

const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(raw: string | undefined): Transform {
  if (raw === undefined) return IDENTITY;
  const parts = raw.trim().split(/\s+/).map(Number.parseFloat);
  if (parts.length !== 12 || parts.some((value) => !Number.isFinite(value))) return IDENTITY;
  return parts;
}

function applyTransform(v: Vec3, m: Transform): Vec3 {
  return {
    x: v.x * (m[0] ?? 0) + v.y * (m[3] ?? 0) + v.z * (m[6] ?? 0) + (m[9] ?? 0),
    y: v.x * (m[1] ?? 0) + v.y * (m[4] ?? 0) + v.z * (m[7] ?? 0) + (m[10] ?? 0),
    z: v.x * (m[2] ?? 0) + v.y * (m[5] ?? 0) + v.z * (m[8] ?? 0) + (m[11] ?? 0),
  };
}

/** 兩個 transform 相乘：先套 inner，再套 outer。 */
function composeTransform(outer: Transform, inner: Transform): Transform {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum += (inner[row * 3 + k] ?? 0) * (outer[k * 3 + col] ?? 0);
      }
      out.push(sum);
    }
  }
  const t = applyTransform({ x: inner[9] ?? 0, y: inner[10] ?? 0, z: inner[11] ?? 0 }, outer);
  out.push(t.x, t.y, t.z);
  return out;
}

// ── XML 掃描 ───────────────────────────────────────────────────────────────
//
// 這裡刻意不引入 XML 解析套件。3MF 的 model 檔可以到數 MB，通用解析器會把整棵 DOM
// 建起來，記憶體與時間都不划算；而我們只需要四種標籤。掃描器只認標籤名與屬性，
// 不處理 CDATA 與註解 —— 3MF 的 model 檔規格上不會出現這兩者。

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(tag);
  while (match !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) result[key] = value;
    match = pattern.exec(tag);
  }
  return result;
}

/** 取出 `<object ...>` 到對應 `</object>`（或自閉合）的區段。 */
type ObjectBlock = {
  readonly id: string;
  readonly attrs: Record<string, string>;
  readonly body: string;
};

function scanObjects(xml: string): readonly ObjectBlock[] {
  const blocks: ObjectBlock[] = [];
  const open = /<object\b([^>]*)>/g;
  let match = open.exec(xml);

  while (match !== null) {
    const head = match[1] ?? '';
    const attrs = attributes(head);
    const id = attrs['id'];
    const selfClosing = head.trimEnd().endsWith('/');

    let body = '';
    if (!selfClosing) {
      const close = xml.indexOf('</object>', open.lastIndex);
      // 3MF 的 resources 是扁平的，object 不會巢狀，所以下一個 </object> 就是自己的。
      body = close === -1 ? '' : xml.slice(open.lastIndex, close);
      if (close !== -1) open.lastIndex = close + '</object>'.length;
    }

    if (id !== undefined) blocks.push({ id, attrs, body });
    match = open.exec(xml);
  }

  return blocks;
}

type RawMesh = {
  readonly vertices: readonly Vec3[];
  readonly faces: readonly (readonly [number, number, number])[];
};

function parseMesh(body: string): RawMesh | undefined {
  const meshStart = body.indexOf('<mesh>');
  if (meshStart === -1) return undefined;

  const vertices: Vec3[] = [];
  const faces: (readonly [number, number, number])[] = [];

  const vertexPattern = /<vertex\b([^>]*)>/g;
  let match = vertexPattern.exec(body);
  while (match !== null) {
    const a = attributes(match[1] ?? '');
    vertices.push({
      x: Number.parseFloat(a['x'] ?? '0'),
      y: Number.parseFloat(a['y'] ?? '0'),
      z: Number.parseFloat(a['z'] ?? '0'),
    });
    match = vertexPattern.exec(body);
  }

  const trianglePattern = /<triangle\b([^>]*)>/g;
  match = trianglePattern.exec(body);
  while (match !== null) {
    const a = attributes(match[1] ?? '');
    const v1 = Number.parseInt(a['v1'] ?? '', 10);
    const v2 = Number.parseInt(a['v2'] ?? '', 10);
    const v3 = Number.parseInt(a['v3'] ?? '', 10);
    if (Number.isInteger(v1) && Number.isInteger(v2) && Number.isInteger(v3)) {
      faces.push([v1, v2, v3]);
    }
    match = trianglePattern.exec(body);
  }

  if (vertices.length === 0 || faces.length === 0) return undefined;
  return { vertices, faces };
}

type ComponentRef = {
  readonly objectId: string;
  /** production extension 的 p:path；同檔引用時為 undefined。 */
  readonly path: string | undefined;
  readonly transform: Transform;
};

function parseComponents(body: string): readonly ComponentRef[] {
  const refs: ComponentRef[] = [];
  const pattern = /<component\b([^>]*)>/g;
  let match = pattern.exec(body);
  while (match !== null) {
    const a = attributes(match[1] ?? '');
    const objectId = a['objectid'];
    if (objectId !== undefined) {
      refs.push({
        objectId,
        path: a['p:path'] ?? a['path'],
        transform: parseTransform(a['transform']),
      });
    }
    match = pattern.exec(body);
  }
  return refs;
}

// ── model_settings.config ─────────────────────────────────────────────────

type PartMetadata = { readonly name: string | undefined; readonly extruder: string | undefined };

/**
 * 讀出每個 part 的名稱與擠出頭。
 *
 * Bambu 把「同一顆實體依高度切成多段換色」也存成獨立的 part，所以這裡拿到的 part
 * 數量往往遠多於機構上的零件數。分辨機構零件是 `clearance.ts` 的工作，不是這裡的。
 */
function readPartMetadata(xml: string): readonly PartMetadata[] {
  const parts: PartMetadata[] = [];
  const pattern = /<part\b([^>]*)>/g;
  let match = pattern.exec(xml);

  while (match !== null) {
    const close = xml.indexOf('</part>', pattern.lastIndex);
    const body = close === -1 ? '' : xml.slice(pattern.lastIndex, close);

    let name: string | undefined;
    let extruder: string | undefined;
    const meta = /<metadata\b([^>]*)\/?>/g;
    let metaMatch = meta.exec(body);
    while (metaMatch !== null) {
      const a = attributes(metaMatch[1] ?? '');
      if (a['key'] === 'name') name = a['value'];
      if (a['key'] === 'extruder') extruder = a['value'];
      metaMatch = meta.exec(body);
    }

    parts.push({ name, extruder });
    if (close !== -1) pattern.lastIndex = close + '</part>'.length;
    match = pattern.exec(xml);
  }

  return parts;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

const ROOT_MODEL = '3D/3dmodel.model';

/** ZIP 的本地檔頭魔數。3MF 就是一個 ZIP。 */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function readModelPart(archive: Buffer, path: string): string | undefined {
  const normalised = path.replace(/^\//, '');
  const direct = readZipEntry(archive, normalised);
  if (direct !== undefined) return direct.toString('utf8');

  // 有些產生器把路徑大小寫寫得跟目錄項不一致，退而求其次用不分大小寫比對。
  const entry = readZipDirectory(archive).find(
    (candidate) => candidate.name.toLowerCase() === normalised.toLowerCase(),
  );
  return entry === undefined ? undefined : readZipEntry(archive, entry.name)?.toString('utf8');
}

type ModelDocument = { readonly objects: Map<string, ObjectBlock> };

function loadDocument(archive: Buffer, path: string, cache: Map<string, ModelDocument>): ModelDocument {
  const key = path.replace(/^\//, '');
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const xml = readModelPart(archive, key);
  if (xml === undefined) {
    throw new ThreeMfReadError(`3MF 內找不到 ${key}`);
  }

  const objects = new Map<string, ObjectBlock>();
  for (const block of scanObjects(xml)) objects.set(block.id, block);

  const document = { objects };
  cache.set(key, document);
  return document;
}

/**
 * 把一個 object 展開成三角形，遞迴解析 components。
 *
 * `seen` 擋住互相引用造成的無限遞迴 —— 規格上不允許，但別人產生的檔案不一定守規矩。
 */
function flatten(
  archive: Buffer,
  documentPath: string,
  objectId: string,
  transform: Transform,
  cache: Map<string, ModelDocument>,
  seen: ReadonlySet<string>,
  sink: (triangles: readonly Triangle[]) => void,
): void {
  const guard = `${documentPath}#${objectId}`;
  if (seen.has(guard)) return;
  const nextSeen = new Set(seen);
  nextSeen.add(guard);

  const document = loadDocument(archive, documentPath, cache);
  const block = document.objects.get(objectId);
  if (block === undefined) return;

  const mesh = parseMesh(block.body);
  if (mesh !== undefined) {
    const placed = mesh.vertices.map((vertex) => applyTransform(vertex, transform));
    const triangles: Triangle[] = [];
    for (const [i, j, k] of mesh.faces) {
      const a = placed[i];
      const b = placed[j];
      const c = placed[k];
      if (a === undefined || b === undefined || c === undefined) continue;
      triangles.push({ a, b, c, declaredNormal: { x: 0, y: 0, z: 0 } });
    }
    if (triangles.length > 0) sink(triangles);
  }

  for (const ref of parseComponents(block.body)) {
    flatten(
      archive,
      ref.path ?? documentPath,
      ref.objectId,
      composeTransform(transform, ref.transform),
      cache,
      nextSeen,
      sink,
    );
  }
}

/**
 * 讀出 3MF 裡所有零件的幾何。
 *
 * 回傳的每個 MeshPart 對應 3MF 結構上的一個零件（component 或獨立 object），
 * 座標已經套用 build item 的擺放 transform。
 */
export function readThreeMfParts(archive: Buffer): readonly MeshPart[] {
  const cache = new Map<string, ModelDocument>();
  const rootXml = readModelPart(archive, ROOT_MODEL);
  if (rootXml === undefined) {
    throw new ThreeMfReadError(`3MF 內找不到 ${ROOT_MODEL}；檔案可能不是 3MF 或已損毀`);
  }

  const settingsXml = readZipEntry(archive, 'Metadata/model_settings.config')?.toString('utf8');
  const metadata = settingsXml === undefined ? [] : readPartMetadata(settingsXml);

  const rootObjects = new Map<string, ObjectBlock>();
  for (const block of scanObjects(rootXml)) rootObjects.set(block.id, block);
  cache.set(ROOT_MODEL, { objects: rootObjects });

  const parts: MeshPart[] = [];
  let index = 0;

  const emit = (triangles: readonly Triangle[]): void => {
    const meta = metadata[index];
    parts.push({
      name: meta?.name ?? `part_${index + 1}`,
      partId: String(index + 1),
      extruder: meta?.extruder,
      triangles,
    });
    index += 1;
  };

  // build 裡的 item 才是「真的要印的東西」。resources 裡可能有沒被引用的 object。
  const itemPattern = /<item\b([^>]*)>/g;
  let match = itemPattern.exec(rootXml);
  let items = 0;

  while (match !== null) {
    const a = attributes(match[1] ?? '');
    const objectId = a['objectid'];
    if (objectId !== undefined) {
      items += 1;
      flatten(archive, ROOT_MODEL, objectId, parseTransform(a['transform']), cache, new Set(), emit);
    }
    match = itemPattern.exec(rootXml);
  }

  if (items === 0) {
    // 沒有 build item 的 3MF 少見但合法（例如只當幾何容器用）。退回把所有 object 都展開。
    for (const id of rootObjects.keys()) {
      flatten(archive, ROOT_MODEL, id, IDENTITY, cache, new Set(), emit);
    }
  }

  if (parts.length === 0) {
    throw new ThreeMfReadError('3MF 解析成功但沒有任何三角形；檔案可能只有設定沒有幾何');
  }

  return parts;
}
