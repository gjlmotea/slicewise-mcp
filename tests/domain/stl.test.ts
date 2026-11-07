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
  it('detects the format by length, not by the leading string', () => {
    expect(isBinaryStl(toBinaryStl(CUBE))).toBe(true);
    expect(isBinaryStl(toAsciiStl(CUBE))).toBe(false);
  });

  it('does not mistake a binary STL whose header starts with solid for ASCII', () => {
    const buffer = toBinaryStl(CUBE);
    buffer.write('solid something', 0, 'ascii');
    expect(isBinaryStl(buffer)).toBe(true);
  });
});

describe('parseStl', () => {
  it('parses the same geometry from binary and ASCII', () => {
    const fromBinary = parseStl(toBinaryStl(CUBE));
    const fromAscii = parseStl(toAsciiStl(CUBE));
    expect(fromBinary).toHaveLength(12);
    expect(fromAscii).toHaveLength(12);
    expect(inspectModel(fromBinary).volumeMm3).toBeCloseTo(
      inspectModel(fromAscii).volumeMm3,
      3,
    );
  });

  it('throws clearly on empty content', () => {
    expect(() => parseStl(Buffer.from('solid empty\nendsolid empty\n'))).toThrow(StlParseError);
  });
});

describe('inspectModel', () => {
  it('computes the volume and surface area of a 20 mm cube', () => {
    const inspection = inspectModel(CUBE);
    expect(inspection.triangleCount).toBe(12);
    expect(inspection.volumeMm3).toBeCloseTo(8000, 6);
    expect(inspection.surfaceAreaMm2).toBeCloseTo(2400, 6);
  });

  it('computes the bounding box size', () => {
    const { boundingBox } = inspectModel(boxTriangles([10, 20, 30], [5, 5, 0]));
    expect(boundingBox.size).toEqual({ x: 10, y: 20, z: 30 });
    expect(boundingBox.min).toEqual({ x: 5, y: 5, z: 0 });
  });

  it('finds no open edges on a closed mesh', () => {
    const inspection = inspectModel(CUBE);
    expect(inspection.openEdges).toBe(0);
    expect(inspection.closed).toBe(true);
  });

  it('detects open edges when a face is missing', () => {
    const holed = CUBE.slice(0, 10); // drop the two triangles of the left face
    const inspection = inspectModel(holed);
    expect(inspection.closed).toBe(false);
    expect(inspection.openEdges).toBeGreaterThan(0);
  });
});

describe('countOpenEdges', () => {
  it('treats all three edges of a single triangle as open', () => {
    expect(countOpenEdges([CUBE[0]!])).toBe(3);
  });
});
