import type { PresetValue, Vec3 } from '../contracts.js';
import { buildZip } from '../slicing/zip-writer.js';
import { meshBounds, type IndexedMesh } from './primitives.js';
import type { Triangle } from './stl.js';

/**
 * Bambu 專案 3MF 的組裝。
 *
 * 這條路的價值在於：Bambu Studio 的非破壞性編輯（挖除體、局部參數區、支撐強制／阻擋）
 * **不是把原始網格改掉**，而是存成「多一個零件 + 一個 subtype 標籤」。
 * 也就是說產生這些編輯完全不需要幾何運算引擎，也不需要驅動 GUI。
 *
 * 檔案結構取自 BambuStudio 02.07.01.62 自己的輸出：
 *
 * ```
 * [Content_Types].xml
 * _rels/.rels                      → 指向 /3D/3dmodel.model
 * 3D/3dmodel.model                 → <object> 內含每個零件一個 <component>
 * 3D/_rels/3dmodel.model.rels      → 指向 /3D/Objects/object_1.model
 * 3D/Objects/object_1.model        → 每個零件一個 <object>，內含實際網格
 * Metadata/model_settings.config   → <part id="N" subtype="..."> 對應 component 的 objectid
 * ```
 *
 * 關鍵對應關係：`<component objectid="N">` 的 N 就是 `<part id="N">` 的 N。
 */

/**
 * 零件類型。
 *
 * 字串取自 BambuStudio 原始碼 `src/libslic3r/Model.cpp` 的
 * `ModelVolume::type_to_string()`，五個值就是全部。
 *
 * **這個型別必須保持封閉。** 讀取端 `ModelVolume::type_from_string()` 對認不得的字串
 * 是靜默回退成 `MODEL_PART`：
 *
 * ```cpp
 * // Default value if invalud type string received.
 * return ModelVolumeType::MODEL_PART;
 * ```
 *
 * 所以 `negative_part` 只要拼錯一個字母，就會從「挖掉一塊」變成「加上一塊實心」——
 * 不會有任何錯誤訊息。實測同一塊幾何：標 `negative_part` 讓 20 mm 立方體變成 15 mm 高，
 * 標 `normal_part` 讓它變成 25 mm 高。所以絕不接受未經驗證的字串。
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
  /** 零件層級設定，主要給 `modifier_part` 用；key 與 process preset 同一套命名空間。 */
  readonly settings?: Readonly<Record<string, PresetValue>>;
};

export type ProjectOptions = {
  readonly objectName: string;
  readonly parts: readonly ModelPart[];
  /** 物件在列印板上的落點，預設為 256×256 板的中心。 */
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

/** 3MF 的 component transform 是 row-major 4×3，最後三個數是位移。 */
const IDENTITY_COMPONENT_TRANSFORM = '1 0 0 0 1 0 0 0 1 0 0 0';
/** model_settings.config 的 matrix 是 row-major 4×4。 */
const IDENTITY_PART_MATRIX = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';

const OBJECTS_PATH = '/3D/Objects/object_1.model';
/** 容器物件的 id 要避開零件用的 id。 */
const CONTAINER_OBJECT_ID = 1000;

export function buildBambuProject(options: ProjectOptions): Buffer {
  const { parts } = options;

  if (parts.length === 0) {
    throw new ThreeMfBuildError('至少要有一個零件。');
  }
  if (parts[0]?.subtype !== 'normal_part') {
    throw new ThreeMfBuildError(
      '第一個零件必須是 normal_part —— 沒有實體本體時，挖除體與修飾體沒有作用對象。',
    );
  }
  for (const part of parts) {
    if (!isPartSubtype(part.subtype)) {
      throw new ThreeMfBuildError(`不合法的零件類型：${String(part.subtype)}`);
    }
    if (part.mesh.triangles.length === 0) {
      throw new ThreeMfBuildError(`零件「${part.name}」沒有任何三角形。`);
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

/** 零件 id 由 1 起算，與 `<component objectid>` 一致。 */
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

/** 避免 `1e-7` 這類科學記號跑進 XML —— 3MF 解析器不一定接受。 */
function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ThreeMfBuildError(`座標不是有限數值：${value}`);
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
 * STL 的三角形湯轉成索引式網格。
 *
 * STL 每個三角形各自帶三個頂點，同一個頂點會重複出現六次以上。
 * 3MF 要的是頂點清單 + 索引，所以要去重。座標量化到 1e-5 mm 再比對 ——
 * 直接比浮點值會因為匯出精度而讓應該相同的頂點對不起來，網格就會裂開。
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
    // 退化面（兩個頂點量化後重合）不寫進 3MF，切片器會抱怨。
    if (a === b || b === c || a === c) continue;
    faces.push([a, b, c]);
  }

  return { vertices, triangles: faces };
}

// ── 讀回 ─────────────────────────────────────────────────────────────────

export type ProjectPart = {
  readonly id: string;
  readonly subtype: string;
  /** subtype 是否為 BambuStudio 認得的五個值之一。 */
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
 * 從 3MF 的 `Metadata/model_settings.config` 讀回物件與零件結構。
 *
 * 這是「寫進去的東西真的在裡面嗎」的驗證手段，也是 GUI 自動化拿不到的東西：
 * 檔案可以解壓縮逐項比對，畫面只能截圖用看的。
 *
 * 用正規表示式而不是完整 XML 解析器：這份檔案是機器產生的，結構極穩定，
 * 而為了讀它引入一個 XML 依賴不划算。遇到解不出來的內容一律回傳空結果，不猜。
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

    // 物件自身的 name 在 <part> 之外的第一個 metadata。
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
