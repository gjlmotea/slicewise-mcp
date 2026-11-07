import type { PresetValue, Vec3 } from '../contracts.js';
import { buildZip } from '../slicing/zip-writer.js';
import { meshBounds, type IndexedMesh } from './primitives.js';
import type { Triangle } from './stl.js';

/**
 * Assembles a Bambu project 3MF.
 *
 * The value of this path: Bambu Studio's non-destructive edits (negative volumes, modifier
 * regions with local settings, support enforcers/blockers) **do not modify the original mesh**.
 * They are stored as "one more part + a subtype tag". So generating these edits needs neither a
 * geometry kernel nor driving the GUI.
 *
 * The file layout is taken from what BambuStudio 02.07.01.62 itself writes:
 *
 * ```
 * [Content_Types].xml
 * _rels/.rels                      → points to /3D/3dmodel.model
 * 3D/3dmodel.model                 → one <object> containing one <component> per part
 * 3D/_rels/3dmodel.model.rels      → points to /3D/Objects/object_1.model
 * 3D/Objects/object_1.model        → one <object> per part, holding the actual mesh
 * Metadata/model_settings.config   → <part id="N" subtype="..."> matches the component's objectid
 * ```
 *
 * The key mapping: the N in `<component objectid="N">` is the N in `<part id="N">`.
 */

/**
 * Part type.
 *
 * The strings come from `ModelVolume::type_to_string()` in the BambuStudio source
 * `src/libslic3r/Model.cpp`; these five values are all of them.
 *
 * **This type must stay closed.** On the read side, `ModelVolume::type_from_string()` silently
 * falls back to `MODEL_PART` for any string it does not recognise:
 *
 * ```cpp
 * // Default value if invalud type string received.
 * return ModelVolumeType::MODEL_PART;
 * ```
 *
 * So a single typo in `negative_part` turns "cut a piece away" into "add a solid piece" — with
 * no error message at all. Measured on the same geometry: tagging it `negative_part` made a 20 mm
 * cube 15 mm tall, tagging it `normal_part` made it 25 mm tall. Never accept an unvalidated string.
 */
export const PART_SUBTYPES = [
  'normal_part',
  'negative_part',
  'modifier_part',
  'support_blocker',
  'support_enforcer',
] as const;

export type PartSubtype = (typeof PART_SUBTYPES)[number];

export function isPartSubtype(value: string): value is PartSubtype {
  return (PART_SUBTYPES as readonly string[]).includes(value);
}

export type ModelPart = {
  readonly name: string;
  readonly subtype: PartSubtype;
  readonly mesh: IndexedMesh;
  /** Per-part settings, mainly for `modifier_part`; keys share the process preset namespace. */
  readonly settings?: Readonly<Record<string, PresetValue>>;
};

export type ProjectOptions = {
  readonly objectName: string;
  readonly parts: readonly ModelPart[];
  /** Where the object lands on the plate; defaults to the centre of a 256×256 plate. */
  readonly plateCentre?: { readonly x: number; readonly y: number };
  readonly application?: string;
};

export class ThreeMfBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreeMfBuildError';
  }
}

const NAMESPACES =
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
  'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
  'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ' +
  'requiredextensions="p"';

/** A 3MF component transform is row-major 4×3; the last three numbers are the translation. */
const IDENTITY_COMPONENT_TRANSFORM = '1 0 0 0 1 0 0 0 1 0 0 0';
/** The matrix in model_settings.config is row-major 4×4. */
const IDENTITY_PART_MATRIX = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';

const OBJECTS_PATH = '/3D/Objects/object_1.model';
/** The container object's id must not collide with the ids used for parts. */
const CONTAINER_OBJECT_ID = 1000;

export function buildBambuProject(options: ProjectOptions): Buffer {
  const { parts } = options;

  if (parts.length === 0) {
    throw new ThreeMfBuildError('At least one part is required.');
  }
  if (parts[0]?.subtype !== 'normal_part') {
    throw new ThreeMfBuildError(
      'The first part must be a normal_part — without a solid body, negative parts and modifiers have nothing to act on.',
    );
  }
  for (const part of parts) {
    if (!isPartSubtype(part.subtype)) {
      throw new ThreeMfBuildError(`Invalid part subtype: ${String(part.subtype)}`);
    }
    if (part.mesh.triangles.length === 0) {
      throw new ThreeMfBuildError(`Part "${part.name}" has no triangles.`);
    }
  }

  const centre = options.plateCentre ?? { x: 128, y: 128 };
  const application = options.application ?? 'slicewise-mcp';

  const objectsModel = renderObjectsModel(parts);
  const rootModel = renderRootModel(parts, centre, application);
  const modelSettings = renderModelSettings(options.objectName, parts);

  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: '3D/3dmodel.model', content: rootModel },
    { name: '3D/_rels/3dmodel.model.rels', content: OBJECTS_RELS },
    { name: OBJECTS_PATH.slice(1), content: objectsModel },
    { name: 'Metadata/model_settings.config', content: modelSettings },
  ]);
}

/** Part ids start at 1, matching `<component objectid>`. */
function partId(index: number): number {
  return index + 1;
}

function renderObjectsModel(parts: readonly ModelPart[]): string {
  const objects = parts
    .map((part, index) => {
      const vertices = part.mesh.vertices
        .map((v) => `     <vertex x="${num(v.x)}" y="${num(v.y)}" z="${num(v.z)}"/>`)
        .join('\n');
      const triangles = part.mesh.triangles
        .map(([a, b, c]) => `     <triangle v1="${a}" v2="${b}" v3="${c}"/>`)
        .join('\n');
      return `  <object id="${partId(index)}" type="model">
   <mesh>
    <vertices>
${vertices}
    </vertices>
    <triangles>
${triangles}
    </triangles>
   </mesh>
  </object>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${NAMESPACES}>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${objects}
 </resources>
 <build/>
</model>
`;
}

function renderRootModel(
  parts: readonly ModelPart[],
  centre: { readonly x: number; readonly y: number },
  application: string,
): string {
  const components = parts
    .map(
      (_, index) =>
        `    <component p:path="${OBJECTS_PATH}" objectid="${partId(index)}" transform="${IDENTITY_COMPONENT_TRANSFORM}"/>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${NAMESPACES}>
 <metadata name="Application">${escapeXml(application)}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="${CONTAINER_OBJECT_ID}" type="model">
   <components>
${components}
   </components>
  </object>
 </resources>
 <build>
  <item objectid="${CONTAINER_OBJECT_ID}" transform="1 0 0 0 1 0 0 0 1 ${num(centre.x)} ${num(centre.y)} 0" printable="1"/>
 </build>
</model>
`;
}

function renderModelSettings(objectName: string, parts: readonly ModelPart[]): string {
  const partEntries = parts
    .map((part, index) => {
      const settings = Object.entries(part.settings ?? {})
        .map(([key, value]) => `      <metadata key="${escapeXml(key)}" value="${escapeXml(serialise(value))}"/>`)
        .join('\n');
      return `    <part id="${partId(index)}" subtype="${part.subtype}">
      <metadata key="name" value="${escapeXml(part.name)}"/>
      <metadata key="matrix" value="${IDENTITY_PART_MATRIX}"/>${settings === '' ? '' : `\n${settings}`}
    </part>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${CONTAINER_OBJECT_ID}">
    <metadata key="name" value="${escapeXml(objectName)}"/>
    <metadata key="extruder" value="1"/>
${partEntries}
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="${CONTAINER_OBJECT_ID}"/>
      <metadata key="instance_id" value="0"/>
    </model_instance>
  </plate>
  <assemble>
  </assemble>
</config>
`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

const OBJECTS_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="${OBJECTS_PATH}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

/** Keep scientific notation such as `1e-7` out of the XML — not every 3MF parser accepts it. */
function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ThreeMfBuildError(`Coordinate is not a finite number: ${value}`);
  }
  const rounded = Number.parseFloat(value.toFixed(6));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function serialise(value: PresetValue): string {
  return typeof value === 'string' ? value : value.join(',');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Converts an STL triangle soup into an indexed mesh.
 *
 * Every STL triangle carries its own three vertices, so the same vertex appears six or more
 * times. 3MF wants a vertex list plus indices, so vertices have to be deduplicated. Coordinates
 * are quantised to 1e-5 mm before comparing — comparing raw floats lets export precision keep
 * vertices that should be identical apart, and the mesh cracks open.
 */
export function trianglesToIndexedMesh(triangles: readonly Triangle[]): IndexedMesh {
  const QUANTUM = 1e5;
  const index = new Map<string, number>();
  const vertices: Vec3[] = [];
  const faces: (readonly [number, number, number])[] = [];

  const idOf = (v: Vec3): number => {
    const key = `${Math.round(v.x * QUANTUM)},${Math.round(v.y * QUANTUM)},${Math.round(v.z * QUANTUM)}`;
    const existing = index.get(key);
    if (existing !== undefined) return existing;
    const id = vertices.length;
    vertices.push(v);
    index.set(key, id);
    return id;
  };

  for (const triangle of triangles) {
    const a = idOf(triangle.a);
    const b = idOf(triangle.b);
    const c = idOf(triangle.c);
    // Degenerate faces (two vertices coincide after quantisation) are left out of the 3MF; the slicer complains about them.
    if (a === b || b === c || a === c) continue;
    faces.push([a, b, c]);
  }

  return { vertices, triangles: faces };
}

// ── Reading back ──────────────────────────────────────────────────────────

export type ProjectPart = {
  readonly id: string;
  readonly subtype: string;
  /** Whether the subtype is one of the five values BambuStudio recognises. */
  readonly recognised: boolean;
  readonly name: string | undefined;
  readonly settings: Readonly<Record<string, string>>;
};

export type ProjectObject = {
  readonly id: string;
  readonly name: string | undefined;
  readonly parts: readonly ProjectPart[];
};

/**
 * Reads the object and part structure back from a 3MF's `Metadata/model_settings.config`.
 *
 * This is how we verify "is what we wrote actually in there", and it is something GUI
 * automation cannot give you: a file can be unzipped and compared item by item, a screen can
 * only be screenshotted and eyeballed.
 *
 * Regular expressions rather than a full XML parser: the file is machine-generated with a very
 * stable structure, and pulling in an XML dependency just to read it is not worth it. Anything
 * that cannot be parsed yields an empty result; we do not guess.
 */
export function readProjectStructure(modelSettingsXml: string): readonly ProjectObject[] {
  const objects: ProjectObject[] = [];
  const objectPattern = /<object\s+id="([^"]+)"\s*>([\s\S]*?)<\/object>/g;

  for (const objectMatch of modelSettingsXml.matchAll(objectPattern)) {
    const id = objectMatch[1] ?? '';
    const body = objectMatch[2] ?? '';

    const parts: ProjectPart[] = [];
    const partPattern = /<part\s+id="([^"]+)"\s+subtype="([^"]*)"\s*>([\s\S]*?)<\/part>/g;

    for (const partMatch of body.matchAll(partPattern)) {
      const partBody = partMatch[3] ?? '';
      const settings: Record<string, string> = {};
      let name: string | undefined;

      for (const meta of partBody.matchAll(/<metadata\s+key="([^"]*)"\s+value="([^"]*)"\s*\/>/g)) {
        const key = unescapeXml(meta[1] ?? '');
        const value = unescapeXml(meta[2] ?? '');
        if (key === 'name') name = value;
        else if (key !== 'matrix') settings[key] = value;
      }

      const subtype = partMatch[2] ?? '';
      parts.push({
        id: partMatch[1] ?? '',
        subtype,
        recognised: isPartSubtype(subtype),
        name,
        settings,
      });
    }

    // The object's own name is the first metadata outside any <part>.
    const objectName = /<metadata\s+key="name"\s+value="([^"]*)"\s*\/>/.exec(body)?.[1];

    objects.push({
      id,
      name: objectName === undefined ? undefined : unescapeXml(objectName),
      parts,
    });
  }

  return objects;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

export { meshBounds };
export type { IndexedMesh };
