import { parseStl, type Triangle } from './stl.js';
import { looksLikeZip, readThreeMfParts, type MeshPart } from './threemf-reader.js';

/**
 * 模型檔載入的單一入口。
 *
 * 呼叫端不該關心檔案是 STL 還是 3MF —— 兩者都只是「一堆三角形」的容器。
 * 判斷一律看內容而不是副檔名：使用者從 MakerWorld 下載的東西常常副檔名與內容不一致，
 * 而 ZIP 魔數是騙不了人的。
 */

export type MeshFileFormat = 'stl' | '3mf';

export type LoadedMesh = {
  readonly format: MeshFileFormat;
  /** 3MF 會有多個零件；STL 一律只有一個。 */
  readonly parts: readonly MeshPart[];
  /** 所有零件合起來的三角形，給不分零件的分析用。 */
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

  const triangles = parseStl(buffer);
  return {
    format: 'stl',
    parts: [{ name: displayName, partId: '1', extruder: undefined, triangles }],
    triangles,
  };
}
