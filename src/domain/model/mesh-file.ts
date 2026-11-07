import { looksLikeObj, parseObj } from './obj.js';
import { isBinaryStl, parseStl, type Triangle } from './stl.js';
import { looksLikeZip, readThreeMfParts, type MeshPart } from './threemf-reader.js';

/**
 * Single entry point for loading model files.
 *
 * Callers should not care whether a file is STL, 3MF or OBJ — all three are just containers
 * for "a pile of triangles". Detection always looks at the content, never the extension: what
 * users download from MakerWorld often has an extension that does not match its content, while
 * the ZIP magic number cannot lie.
 */

export type MeshFileFormat = 'stl' | '3mf' | 'obj';

export type LoadedMesh = {
  readonly format: MeshFileFormat;
  /** 3MF and OBJ can have several parts; STL always has exactly one. */
  readonly parts: readonly MeshPart[];
  /** Triangles of all parts combined, for analyses that do not distinguish parts. */
  readonly triangles: readonly Triangle[];
};

export function loadMesh(buffer: Buffer, displayName = 'model'): LoadedMesh {
  if (looksLikeZip(buffer)) {
    const parts = readThreeMfParts(buffer);
    return {
      format: '3mf',
      parts,
      triangles: parts.flatMap((part) => part.triangles),
    };
  }

  // Check for binary STL first: its 80-byte header is arbitrary and may happen to contain
  // OBJ-looking text. The binary length formula cannot lie, and an OBJ will not happen to fit it.
  if (!isBinaryStl(buffer) && looksLikeObj(buffer)) {
    const parts = parseObj(buffer.toString('utf8'), displayName);
    return {
      format: 'obj',
      parts,
      triangles: parts.flatMap((part) => part.triangles),
    };
  }

  const triangles = parseStl(buffer);
  return {
    format: 'stl',
    parts: [{ name: displayName, partId: '1', extruder: undefined, triangles }],
    triangles,
  };
}
