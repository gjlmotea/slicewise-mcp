import { describe, expect, it } from 'vitest';

import { buildPrimitive } from '../../src/domain/model/primitives.js';
import {
  buildBambuProject,
  isPartSubtype,
  PART_SUBTYPES,
  readProjectStructure,
  ThreeMfBuildError,
  trianglesToIndexedMesh,
} from '../../src/domain/model/threemf.js';
import { readZipDirectory, readZipEntry } from '../../src/domain/slicing/zip.js';
import { boxTriangles } from '../fixtures/geometry.js';

const CUBE = buildPrimitive({ kind: 'box', size: { x: 20, y: 20, z: 20 } });
const HOLE = buildPrimitive({ kind: 'cylinder', diameter: 6, height: 30 });

function project(parts: Parameters<typeof buildBambuProject>[0]['parts']) {
  return buildBambuProject({ objectName: 'test', parts });
}

const BODY = { name: 'body', subtype: 'normal_part', mesh: CUBE } as const;

describe('零件類型', () => {
  it('只認得 BambuStudio 原始碼裡的五個值', () => {
    expect(PART_SUBTYPES).toEqual([
      'normal_part',
      'negative_part',
      'modifier_part',
      'support_blocker',
      'support_enforcer',
    ]);
  });

  it('拒絕拼錯的類型', () => {
    // BambuStudio 的 type_from_string 對認不得的字串是靜默回退成 MODEL_PART：
    // 「挖掉一塊」會變成「加上一塊實心」，而且沒有任何錯誤訊息。
    // 實測同一塊幾何：negative_part 讓 20 mm 立方體變 15 mm，normal_part 讓它變 25 mm。
    expect(isPartSubtype('negative_part')).toBe(true);
    expect(isPartSubtype('negative-part')).toBe(false);
    expect(isPartSubtype('negativepart')).toBe(false);
    expect(isPartSubtype('')).toBe(false);
  });
});

describe('buildBambuProject', () => {
  it('產出 BambuStudio 需要的六個容器檔', () => {
    const entries = readZipDirectory(project([BODY]));
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
      '3D/_rels/3dmodel.model.rels',
      '3D/Objects/object_1.model',
      'Metadata/model_settings.config',
    ]);
  });

  it('component 的 objectid 與 part 的 id 對得起來', () => {
    // 這是整個格式的樞紐：對不上就會靜默套錯零件的類型。
    const buffer = project([BODY, { name: 'hole', subtype: 'negative_part', mesh: HOLE }]);
    const root = readZipEntry(buffer, '3D/3dmodel.model')!.toString('utf8');
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');

    const componentIds = [...root.matchAll(/objectid="(\d+)"/g)].map((m) => m[1]);
    const partIds = [...settings.matchAll(/<part id="(\d+)"/g)].map((m) => m[1]);

    // objectid 也出現在 <build><item>，所以取零件那幾個。
    expect(partIds).toEqual(['1', '2']);
    expect(componentIds).toContain('1');
    expect(componentIds).toContain('2');
  });

  it('把 subtype 寫進 model_settings.config', () => {
    const buffer = project([BODY, { name: 'hole', subtype: 'negative_part', mesh: HOLE }]);
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(settings).toContain('subtype="normal_part"');
    expect(settings).toContain('subtype="negative_part"');
  });

  it('modifier 的零件層級設定寫進 part 區塊', () => {
    const buffer = project([
      BODY,
      {
        name: 'reinforce',
        subtype: 'modifier_part',
        mesh: HOLE,
        settings: { sparse_infill_density: '60%', wall_loops: '5' },
      },
    ]);
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(settings).toContain('key="sparse_infill_density" value="60%"');
    expect(settings).toContain('key="wall_loops" value="5"');
  });

  it('沒有零件時拒絕', () => {
    expect(() => project([])).toThrow(ThreeMfBuildError);
  });

  it('第一個零件不是本體時拒絕', () => {
    // 沒有實體本體，挖除體沒有作用對象，會產生一個合法但空的專案。
    expect(() => project([{ name: 'hole', subtype: 'negative_part', mesh: HOLE }])).toThrow(
      /第一個零件必須是 normal_part/,
    );
  });

  it('空網格時拒絕', () => {
    expect(() =>
      project([BODY, { name: 'empty', subtype: 'negative_part', mesh: { vertices: [], triangles: [] } }]),
    ).toThrow(/沒有任何三角形/);
  });

  it('轉義名稱裡的 XML 特殊字元', () => {
    const buffer = buildBambuProject({
      objectName: 'a & b <c>',
      parts: [{ name: '"quoted"', subtype: 'normal_part', mesh: CUBE }],
    });
    const settings = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(settings).toContain('a &amp; b &lt;c&gt;');
    expect(settings).toContain('&quot;quoted&quot;');
  });

  it('座標不用科學記號', () => {
    // 3MF 解析器不一定接受 1e-7 這種寫法。
    const tiny = buildPrimitive({ kind: 'box', size: { x: 0.0000001, y: 20, z: 20 } });
    const buffer = project([{ name: 'tiny', subtype: 'normal_part', mesh: tiny }]);
    const objects = readZipEntry(buffer, '3D/Objects/object_1.model')!.toString('utf8');
    expect(objects).not.toMatch(/[0-9]e-?[0-9]/i);
  });
});

describe('readProjectStructure', () => {
  it('把寫進去的結構原樣讀回來', () => {
    const buffer = project([
      BODY,
      { name: 'hole', subtype: 'negative_part', mesh: HOLE },
      { name: 'dense', subtype: 'modifier_part', mesh: HOLE, settings: { wall_loops: '5' } },
    ]);
    const xml = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    const objects = readProjectStructure(xml);

    expect(objects).toHaveLength(1);
    expect(objects[0]?.name).toBe('test');
    expect(objects[0]?.parts.map((part) => [part.name, part.subtype])).toEqual([
      ['body', 'normal_part'],
      ['hole', 'negative_part'],
      ['dense', 'modifier_part'],
    ]);
    expect(objects[0]?.parts[2]?.settings).toEqual({ wall_loops: '5' });
  });

  it('標出 BambuStudio 認不得的 subtype', () => {
    const xml = `<config><object id="1">
      <part id="1" subtype="negative-part"><metadata key="name" value="x"/></part>
    </object></config>`;
    const parts = readProjectStructure(xml)[0]?.parts ?? [];
    expect(parts[0]?.recognised).toBe(false);
  });

  it('matrix 不算成零件設定', () => {
    const buffer = project([BODY]);
    const xml = readZipEntry(buffer, 'Metadata/model_settings.config')!.toString('utf8');
    expect(readProjectStructure(xml)[0]?.parts[0]?.settings).toEqual({});
  });

  it('解不出來時回空陣列，不猜', () => {
    expect(readProjectStructure('這不是 XML')).toEqual([]);
  });
});

describe('trianglesToIndexedMesh', () => {
  it('把重複頂點去重', () => {
    // STL 的立方體有 12 個三角形 × 3 = 36 個頂點，但實際只有 8 個相異頂點。
    const mesh = trianglesToIndexedMesh(boxTriangles([20, 20, 20]));
    expect(mesh.vertices).toHaveLength(8);
    expect(mesh.triangles).toHaveLength(12);
  });

  it('丟掉退化三角形', () => {
    const point = { x: 1, y: 1, z: 1 };
    const mesh = trianglesToIndexedMesh([
      { a: point, b: point, c: point, declaredNormal: point },
    ]);
    expect(mesh.triangles).toHaveLength(0);
  });
});
