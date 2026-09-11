import { describe, expect, it } from 'vitest';

import {
  countOpenEdges,
  inspectModel,
  isBinaryStl,
  parseStl,
  StlParseError,
} from '../../src/domain/model/stl.js';
import { boxTriangles, toAsciiStl, toBinaryStl } from '../fixtures/geometry.js';

const CUBE = boxTriangles([20, 20, 20]);

describe('isBinaryStl', () => {
  it('以長度而不是開頭字串判別格式', () => {
    expect(isBinaryStl(toBinaryStl(CUBE))).toBe(true);
    expect(isBinaryStl(toAsciiStl(CUBE))).toBe(false);
  });

  it('標頭以 solid 開頭的 binary STL 不會被誤判成 ASCII', () => {
    const buffer = toBinaryStl(CUBE);
    buffer.write('solid something', 0, 'ascii');
    expect(isBinaryStl(buffer)).toBe(true);
  });
});

describe('parseStl', () => {
  it('binary 與 ASCII 解析出相同幾何', () => {
    const fromBinary = parseStl(toBinaryStl(CUBE));
    const fromAscii = parseStl(toAsciiStl(CUBE));
    expect(fromBinary).toHaveLength(12);
    expect(fromAscii).toHaveLength(12);
    expect(inspectModel(fromBinary).volumeMm3).toBeCloseTo(
      inspectModel(fromAscii).volumeMm3,
      3,
    );
  });

  it('空內容時明確報錯', () => {
    expect(() => parseStl(Buffer.from('solid empty\nendsolid empty\n'))).toThrow(StlParseError);
  });
});

describe('inspectModel', () => {
  it('算出 20 mm 方塊的體積與表面積', () => {
    const inspection = inspectModel(CUBE);
    expect(inspection.triangleCount).toBe(12);
    expect(inspection.volumeMm3).toBeCloseTo(8000, 6);
    expect(inspection.surfaceAreaMm2).toBeCloseTo(2400, 6);
  });

  it('算出外框尺寸', () => {
    const { boundingBox } = inspectModel(boxTriangles([10, 20, 30], [5, 5, 0]));
    expect(boundingBox.size).toEqual({ x: 10, y: 20, z: 30 });
    expect(boundingBox.min).toEqual({ x: 5, y: 5, z: 0 });
  });

  it('封閉網格沒有開放邊', () => {
    const inspection = inspectModel(CUBE);
    expect(inspection.openEdges).toBe(0);
    expect(inspection.closed).toBe(true);
  });

  it('缺一面時偵測到開放邊', () => {
    const holed = CUBE.slice(0, 10); // 拿掉左面兩個三角形
    const inspection = inspectModel(holed);
    expect(inspection.closed).toBe(false);
    expect(inspection.openEdges).toBeGreaterThan(0);
  });
});

describe('countOpenEdges', () => {
  it('單一三角形的三條邊都是開放的', () => {
    expect(countOpenEdges([CUBE[0]!])).toBe(3);
  });
});
