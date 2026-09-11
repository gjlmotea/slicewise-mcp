import { describe, expect, it } from 'vitest';

import { buildPrimitive } from '../../src/domain/model/primitives.js';
import { buildBambuProject } from '../../src/domain/model/threemf.js';
import { looksLikeZip, readThreeMfParts, ThreeMfReadError } from '../../src/domain/model/threemf-reader.js';
import { loadMesh } from '../../src/domain/model/mesh-file.js';
import { boundingBox } from '../../src/domain/model/stl.js';
import { boxTriangles } from '../fixtures/geometry.js';
import { buildStoredZip } from '../fixtures/zip-builder.js';

/**
 * 這一組測試走的是「寫出去再讀回來」的往返路徑。
 *
 * 用 buildBambuProject 產生 3MF 再用 readThreeMfParts 讀，兩邊是各自獨立寫的程式碼；
 * 如果 transform 的行列慣例搞錯，往返出來的座標就會對不上，測試會抓到。
 * 拿真實檔案當 fixture 反而驗不到這個 —— 因為看不出「應該是多少」。
 */

const CUBE = buildPrimitive({ kind: 'box', size: { x: 20, y: 20, z: 20 } }, { x: 0, y: 0, z: 0 });
const OFFSET_CUBE = buildPrimitive({ kind: 'box', size: { x: 10, y: 10, z: 10 } }, { x: 40, y: 0, z: 0 });

function project(parts: Parameters<typeof buildBambuProject>[0]['parts']) {
  return buildBambuProject({ objectName: 'roundtrip', parts });
}

describe('格式判斷', () => {
  it('看內容的 ZIP 魔數，不看副檔名', () => {
    const archive = project([{ name: 'body', subtype: 'normal_part', mesh: CUBE }]);
    expect(looksLikeZip(archive)).toBe(true);
    expect(looksLikeZip(Buffer.from('solid ascii stl\nfacet normal 0 0 0\n'))).toBe(false);
  });

  it('loadMesh 把 STL 與 3MF 收斂成同一種形狀', () => {
    const archive = project([{ name: 'body', subtype: 'normal_part', mesh: CUBE }]);
    const fromThreeMf = loadMesh(archive);
    expect(fromThreeMf.format).toBe('3mf');

    const stl = stlBuffer();
    const fromStl = loadMesh(stl, 'cube.stl');
    expect(fromStl.format).toBe('stl');
    // STL 沒有零件概念，一律當成單一零件。
    expect(fromStl.parts).toHaveLength(1);
    expect(fromStl.parts[0]?.name).toBe('cube.stl');
  });
});

describe('3MF 幾何讀取', () => {
  it('讀得到零件數與三角形數', () => {
    const archive = project([
      { name: 'body', subtype: 'normal_part', mesh: CUBE },
      { name: 'satellite', subtype: 'normal_part', mesh: OFFSET_CUBE },
    ]);

    const parts = readThreeMfParts(archive);
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.name)).toEqual(['body', 'satellite']);
    expect(parts[0]?.triangles).toHaveLength(CUBE.triangles.length);
  });

  it('座標往返一致：讀回來的外框等於寫進去的形狀加上擺放位移', () => {
    const archive = project([{ name: 'body', subtype: 'normal_part', mesh: CUBE }]);
    const parts = readThreeMfParts(archive);
    const box = boundingBox(parts[0]?.triangles ?? []);

    // 立方體邊長 20 —— 尺寸不受 transform 影響，位移錯了尺寸也不會變，所以另外驗中心。
    expect(box.size.x).toBeCloseTo(20, 6);
    expect(box.size.y).toBeCloseTo(20, 6);
    expect(box.size.z).toBeCloseTo(20, 6);

    // buildBambuProject 會把物件擺到板面中心 (128, 128)。
    // 平移若被寫成行向量而不是列向量，中心會落在別的地方。
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(128, 6);
    expect((box.min.y + box.max.y) / 2).toBeCloseTo(128, 6);
  });

  it('多個零件各自套用自己的位移', () => {
    const archive = project([
      { name: 'body', subtype: 'normal_part', mesh: CUBE },
      { name: 'satellite', subtype: 'normal_part', mesh: OFFSET_CUBE },
    ]);
    const parts = readThreeMfParts(archive);
    const bodyBox = boundingBox(parts[0]?.triangles ?? []);
    const satelliteBox = boundingBox(parts[1]?.triangles ?? []);

    // 原始幾何相差 40 mm，讀回來也必須相差 40 mm。
    const bodyCentre = (bodyBox.min.x + bodyBox.max.x) / 2;
    const satelliteCentre = (satelliteBox.min.x + satelliteBox.max.x) / 2;
    expect(satelliteCentre - bodyCentre).toBeCloseTo(40, 6);
  });

  it('不是 3MF 的 ZIP 會明講找不到 model 檔，而不是回空結果', () => {
    // 一個合法的 ZIP，但裡面沒有 3D/3dmodel.model。
    const notThreeMf = Buffer.concat([
      Buffer.from('PK'),
      Buffer.alloc(60),
    ]);
    expect(() => readThreeMfParts(notThreeMf)).toThrow();
  });

  it('有 model 檔但沒有幾何時明確報錯，不是靜默回零個零件', () => {
    // 結構合法、只是沒有任何三角形。這種檔案最危險：不報錯的話，
    // 呼叫端會拿到「0 個零件」並當成「這個模型沒有可動零件」。
    const empty = buildStoredZip([
      {
        name: '3D/3dmodel.model',
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<model unit="millimeter"><resources></resources><build></build></model>',
      },
    ]);
    expect(() => readThreeMfParts(empty)).toThrow(ThreeMfReadError);
  });

  it('引用不存在的 model 檔時報出缺哪一個，而不是回部分結果', () => {
    const dangling = buildStoredZip([
      {
        name: '3D/3dmodel.model',
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<model unit="millimeter"><resources>' +
          '<object id="1" type="model"><components>' +
          '<component p:path="/3D/Objects/missing.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>' +
          '</components></object></resources>' +
          '<build><item objectid="1"/></build></model>',
      },
    ]);
    expect(() => readThreeMfParts(dangling)).toThrow(/missing\.model/);
  });
});

/** 產生一個 binary STL，內容是 20 mm 立方體。 */
function stlBuffer(): Buffer {
  const triangles = boxTriangles([20, 20, 20]);
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const vertex of [triangle.a, triangle.b, triangle.c]) {
      buffer.writeFloatLE(vertex.x, offset);
      buffer.writeFloatLE(vertex.y, offset + 4);
      buffer.writeFloatLE(vertex.z, offset + 8);
      offset += 12;
    }
  });
  return buffer;
}
