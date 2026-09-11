import type { Vec3 } from '../contracts.js';
import type { Triangle } from './stl.js';
import { boxDistance, distanceBetween, dot, subtract, TriangleSet } from './triangle-set.js';

/**
 * 接觸判定：兩組三角形是不是同一顆實體的一部分。
 *
 * 這跟「最小距離」是不同的問題，而且便宜得多。
 * 最小距離要把精確值找出來，得掃過所有可能更近的地方；接觸判定只要回答是非題，
 * 一旦找到證據就結束，而且搜尋半徑固定是那個很小的容差，網格幾乎每次都只看一格。
 *
 * 「同一顆實體」有兩種形態，兩種都要認：
 *
 * 1. **貼合** —— 換色切面那種，兩個面完全重疊，距離 0。用距離查詢就抓得到。
 * 2. **穿透** —— 插銷插進孔裡、裝飾球嵌在環上。這種兩邊的頂點可能離對方表面好幾 mm，
 *    真正距離 0 的是兩個面「交叉」的那條線。距離查詢抓不到，要用相交測試。
 */

/**
 * 線段與三角形相交（Möller–Trumbore）。
 *
 * 回傳交點是否落在線段上（t ∈ [0, 1]）且在三角形內。
 * 平行於三角形平面的線段回傳 false —— 那種情況是共面，會由距離查詢那一路抓到。
 */
function segmentHitsTriangle(p: Vec3, q: Vec3, t: Triangle): boolean {
  const direction = subtract(q, p);
  const edge1 = subtract(t.b, t.a);
  const edge2 = subtract(t.c, t.a);

  const h = {
    x: direction.y * edge2.z - direction.z * edge2.y,
    y: direction.z * edge2.x - direction.x * edge2.z,
    z: direction.x * edge2.y - direction.y * edge2.x,
  };
  const determinant = dot(edge1, h);
  if (Math.abs(determinant) < 1e-12) return false;

  const inverse = 1 / determinant;
  const s = subtract(p, t.a);
  const u = inverse * dot(s, h);
  if (u < 0 || u > 1) return false;

  const qv = {
    x: s.y * edge1.z - s.z * edge1.y,
    y: s.z * edge1.x - s.x * edge1.z,
    z: s.x * edge1.y - s.y * edge1.x,
  };
  const v = inverse * dot(direction, qv);
  if (v < 0 || u + v > 1) return false;

  const hit = inverse * dot(edge2, qv);
  return hit >= 0 && hit <= 1;
}

/**
 * 兩個三角形是否相交。
 *
 * 用「六條邊各自對另一個三角形做線段相交」判定。非共面的相交一定會讓至少一條邊穿過
 * 另一個三角形，所以這六次測試是完備的；共面的情況距離是 0，由呼叫端的距離查詢負責。
 */
function trianglesIntersect(a: Triangle, b: Triangle): boolean {
  return (
    segmentHitsTriangle(a.a, a.b, b) ||
    segmentHitsTriangle(a.b, a.c, b) ||
    segmentHitsTriangle(a.c, a.a, b) ||
    segmentHitsTriangle(b.a, b.b, a) ||
    segmentHitsTriangle(b.b, b.c, a) ||
    segmentHitsTriangle(b.c, b.a, a)
  );
}

/**
 * 兩組三角形是否在 `epsilon` 內接觸或互相穿透。
 *
 * 一找到證據就回 true。所有搜尋半徑都固定在 epsilon，所以網格剪枝非常有效 ——
 * 這是它比「算出精確最小距離再比較」快上兩個數量級的原因。
 */
export function surfacesTouch(a: TriangleSet, b: TriangleSet, epsilon: number): boolean {
  if (a.triangles.length === 0 || b.triangles.length === 0) return false;
  if (boxDistance(a.box, b.box) > epsilon) return false;

  // 讓三角形少的那一邊當來源、多的那一邊當查詢目標，掃描次數比較少。
  const [source, target] =
    a.triangles.length <= b.triangles.length ? ([a, b] as const) : ([b, a] as const);

  let touching = false;

  for (let index = 0; index < source.triangles.length && !touching; index += 1) {
    const triangle = source.triangles[index];
    if (triangle === undefined) continue;
    const box = source.boundsOf(index);
    if (boxDistance(box, target.box) > epsilon) continue;

    // 一、貼合：頂點落在對方表面上。
    for (const vertex of [triangle.a, triangle.b, triangle.c]) {
      const hit = target.nearestWithin(vertex, epsilon);
      if (hit !== undefined) {
        touching = true;
        break;
      }
    }
    if (touching) break;

    // 二、穿透：邊與對方的面交叉。只測 AABB 有交集的候選。
    target.forEachNear(box, epsilon, (candidate) => {
      const other = target.triangles[candidate];
      if (other === undefined) return false;
      if (boxDistance(box, target.boundsOf(candidate)) > epsilon) return false;
      if (trianglesIntersect(triangle, other)) {
        touching = true;
        return true;
      }
      return false;
    });
  }

  return touching;
}

/** 給測試與診斷用：回報兩個三角形是否相交。 */
export const trianglesIntersectForTest = trianglesIntersect;

/** 給測試用：線段與三角形相交。 */
export const segmentHitsTriangleForTest = segmentHitsTriangle;

/** 幾何小工具再匯出，讓接觸判定的使用者不必再 import triangle-set。 */
export { distanceBetween };
