import type { Vec3 } from '../contracts.js';
import { readZipDirectory, readZipEntry } from '../slicing/zip.js';
import type { Triangle } from './stl.js';

/**
 * Reads the actual geometry out of a 3MF.
 *
 * `threemf.ts` does the writing; this module does the reading. They are separate because the
 * hard parts differ: when writing, we decide the structure; when reading, we face files other
 * tools produced — especially the Bambu/MakerWorld style that splits meshes into
 * `3D/Objects/*.model` and references them back from the root file through the production
 * extension's `p:path`. Reading only the root file gets you nothing.
 *
 * Coordinates are always resolved to "where it sits on the plate": both component transforms
 * and build item transforms are applied. That way the numbers we measure are in the same frame
 * the user sees in Studio.
 */

export class ThreeMfReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreeMfReadError';
  }
}

/** One part of a 3MF: a set of triangles already resolved to world coordinates. */
export type MeshPart = {
  /** Display name. Taken from model_settings.config; falls back to one built from the object id. */
  readonly name: string;
  /** This part's part id within the 3MF (from the order in model_settings.config). */
  readonly partId: string;
  /** Assigned extruder number; undefined when there is no multi-colour information. */
  readonly extruder: string | undefined;
  /**
   * Bambu part type (normal_part / negative_part / modifier_part / support_blocker / support_enforcer).
   * Undefined when not declared, which means normal_part. Only normal_part is a solid that gets printed.
   */
  readonly subtype?: string;
  /** OBJ usemtl material name; Bambu assigns filament slots by material when importing an OBJ. */
  readonly material?: string;
  readonly triangles: readonly Triangle[];
};

/**
 * A 3MF transform is 12 numbers, a row-major 4×3.
 * It is applied as a row vector multiplied on the right: `p' = p · M + t`, where t is the last three numbers.
 * Getting it wrong as a column vector moves the translation onto other axes without any error —
 * it just quietly measures the wrong distances.
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

/** Multiplies two transforms: inner is applied first, then outer. */
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

// ── XML scanning ──────────────────────────────────────────────────────────
//
// No XML parsing package on purpose. A 3MF model file can be several MB; a general-purpose
// parser builds the whole DOM, which costs memory and time we don't need to spend, and we only
// need four kinds of tags. The scanner understands only tag names and attributes and does not
// handle CDATA or comments — by spec, neither appears in a 3MF model file.

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

/** The span from `<object ...>` to its matching `</object>` (or a self-closing tag). */
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
      // 3MF resources are flat and objects never nest, so the next </object> is this one's.
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
  /** The production extension's p:path; undefined for a reference within the same file. */
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

type PartMetadata = {
  readonly name: string | undefined;
  readonly extruder: string | undefined;
  readonly subtype: string | undefined;
};

/**
 * Reads each part's name and extruder.
 *
 * Bambu also stores "one solid split into height bands for colour changes" as separate parts,
 * so the number of parts seen here is often far larger than the number of mechanical parts.
 * Telling mechanical parts apart is `clearance.ts`'s job, not this module's.
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

    parts.push({ name, extruder, subtype: attributes(match[1] ?? '')['subtype'] });
    if (close !== -1) pattern.lastIndex = close + '</part>'.length;
    match = pattern.exec(xml);
  }

  return parts;
}

// ── Main flow ─────────────────────────────────────────────────────────────

const ROOT_MODEL = '3D/3dmodel.model';

/** ZIP local file header magic. A 3MF is a ZIP. */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function readModelPart(archive: Buffer, path: string): string | undefined {
  const normalised = path.replace(/^\//, '');
  const direct = readZipEntry(archive, normalised);
  if (direct !== undefined) return direct.toString('utf8');

  // Some producers write the path with different casing from the directory entry; fall back to a case-insensitive match.
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
    throw new ThreeMfReadError(`${key} not found inside the 3MF`);
  }

  const objects = new Map<string, ObjectBlock>();
  for (const block of scanObjects(xml)) objects.set(block.id, block);

  const document = { objects };
  cache.set(key, document);
  return document;
}

/**
 * Expands one object into triangles, resolving components recursively.
 *
 * `seen` stops infinite recursion from mutual references — the spec forbids them, but files
 * produced by other tools don't always follow the rules.
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
 * Reads the geometry of every part in a 3MF.
 *
 * Each returned MeshPart corresponds to one structural part of the 3MF (a component or a
 * standalone object), with the build item's placement transform already applied.
 */
export function readThreeMfParts(archive: Buffer): readonly MeshPart[] {
  const cache = new Map<string, ModelDocument>();
  const rootXml = readModelPart(archive, ROOT_MODEL);
  if (rootXml === undefined) {
    throw new ThreeMfReadError(`${ROOT_MODEL} not found inside the 3MF; the file may not be a 3MF or may be corrupted`);
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
      ...(meta?.subtype === undefined ? {} : { subtype: meta.subtype }),
      triangles,
    });
    index += 1;
  };

  // Items in <build> are "what actually gets printed". <resources> may hold objects nothing references.
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
    // A 3MF with no build items is rare but legal (e.g. used purely as a geometry container). Fall back to expanding every object.
    for (const id of rootObjects.keys()) {
      flatten(archive, ROOT_MODEL, id, IDENTITY, cache, new Set(), emit);
    }
  }

  if (parts.length === 0) {
    throw new ThreeMfReadError('The 3MF parsed but contains no triangles; the file may hold settings only and no geometry');
  }

  return parts;
}
