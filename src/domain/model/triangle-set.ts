import type { BoundingBox, Vec3 } from '../contracts.js';
import type { Triangle } from './stl.js';

/**
 * 一組三角形，附帶查詢用的 BVH（bounding volume hierarchy）。
 *
 * 從 `clearance.ts` 拆出來是因為效能：原本每比對一組零件就重建一次索引，
 * 而行星齒輪陀螺的外齒圈有三萬多個三角形、要跟九個零件各比一次。
 * 索引跟著資料走、只建一次，才是對的歸屬。
 *
 * 為什麼是 BVH 而不是均勻網格：第一版用網格，實測 CPU profile 顯示
 * **96% 的時間花在 `nearestWithin` 自己身上，而不是幾何計算**——
 * 也就是說時間全耗在「掃過一格又一格的空格子」。均勻網格對這種資料是錯的結構：
 * 齒輪是薄殼，三角形集中在表面上，大部分格子是空的；而搜尋半徑一旦大一點，
 * 要掃的格數就以半徑的平方成長。BVH 的每一層都用實際佔用範圍剪枝，
 * 空的地方根本不會被走到。
 */

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function scaleAdd(a: Vec3, b: Vec3, scale: number): Vec3 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

export function distanceBetween(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 點到三角形的最近點（Ericson, Real-Time Collision Detection §5.1.5）。
 *
 * 用頂點對頂點的距離近似會高估：兩個面對面的平坦齒面，最近的一對可能落在面內部而不是
 * 任何一個頂點上。列印即組裝的公差只有 0.1 mm 上下，高估 0.05 mm 就足以把「會黏死」
 * 誤判成「安全」，所以這裡算的是真正的點到面距離。
 */
export function closestPointOnTriangle(p: Vec3, t: Triangle): Vec3 {
  const ab = subtract(t.b, t.a);
  const ac = subtract(t.c, t.a);
  const ap = subtract(p, t.a);

  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return t.a;

  const bp = subtract(p, t.b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return t.b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const denom = d1 - d3;
    return denom === 0 ? t.a : scaleAdd(t.a, ab, d1 / denom);
  }

  const cp = subtract(p, t.c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return t.c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const denom = d2 - d6;
    return denom === 0 ? t.a : scaleAdd(t.a, ac, d2 / denom);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const denom = d4 - d3 + (d5 - d6);
    return denom === 0 ? t.b : scaleAdd(t.b, subtract(t.c, t.b), (d4 - d3) / denom);
  }

  const denom = va + vb + vc;
  if (denom === 0) return t.a;
  return scaleAdd(scaleAdd(t.a, ab, vb / denom), ac, vc / denom);
}

/** 兩個 AABB 之間的最小距離；重疊時為 0。這是剪枝用的下界，永遠不會高估。 */
export function boxDistance(a: BoundingBox, b: BoundingBox): number {
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 外框 `outer` 在 XY 平面上是否完全包住 `inner`。 */
export function enclosesXY(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    outer.min.x <= inner.min.x &&
    outer.min.y <= inner.min.y &&
    outer.max.x >= inner.max.x &&
    outer.max.y >= inner.max.y
  );
}

/** 一個葉節點最多放幾個三角形。太小會讓樹太深，太大會讓剪枝變粗。 */
const LEAF_SIZE = 8;

export class TriangleSet {
  readonly triangles: readonly Triangle[];
  /** 每個三角形的 AABB，攤平成 6 個 float 一組。typed array 是為了避免上萬個小物件。 */
  readonly #bounds: Float64Array;
  readonly box: BoundingBox;

  /** BVH 節點的 AABB，同樣 6 個 float 一組。 */
  readonly #nodeBounds: Float64Array;
  /** 內部節點：右子節點的索引（左子節點永遠是 self + 1）。葉節點為 -1。 */
  readonly #nodeRight: Int32Array;
  /** 葉節點在 #order 裡的起點與數量；內部節點為 -1 / 0。 */
  readonly #nodeStart: Int32Array;
  readonly #nodeCount: Int32Array;
  /** 三角形索引的排列，葉節點指向這裡的連續區段。 */
  readonly #order: Int32Array;
  readonly #nodeTotal: number;

  constructor(triangles: readonly Triangle[]) {
    this.triangles = triangles;
    const count = triangles.length;
    this.#bounds = new Float64Array(count * 6);

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    const centroids = new Float64Array(count * 3);

    for (let index = 0; index < count; index += 1) {
      const t = triangles[index];
      if (t === undefined) continue;
      const base = index * 6;
      const bx0 = Math.min(t.a.x, t.b.x, t.c.x);
      const by0 = Math.min(t.a.y, t.b.y, t.c.y);
      const bz0 = Math.min(t.a.z, t.b.z, t.c.z);
      const bx1 = Math.max(t.a.x, t.b.x, t.c.x);
      const by1 = Math.max(t.a.y, t.b.y, t.c.y);
      const bz1 = Math.max(t.a.z, t.b.z, t.c.z);
      this.#bounds[base] = bx0;
      this.#bounds[base + 1] = by0;
      this.#bounds[base + 2] = bz0;
      this.#bounds[base + 3] = bx1;
      this.#bounds[base + 4] = by1;
      this.#bounds[base + 5] = bz1;

      centroids[index * 3] = (bx0 + bx1) / 2;
      centroids[index * 3 + 1] = (by0 + by1) / 2;
      centroids[index * 3 + 2] = (bz0 + bz1) / 2;

      if (bx0 < minX) minX = bx0;
      if (by0 < minY) minY = by0;
      if (bz0 < minZ) minZ = bz0;
      if (bx1 > maxX) maxX = bx1;
      if (by1 > maxY) maxY = by1;
      if (bz1 > maxZ) maxZ = bz1;
    }

    if (count === 0) {
      minX = 0;
      minY = 0;
      minZ = 0;
      maxX = 0;
      maxY = 0;
      maxZ = 0;
    }

    const min = { x: minX, y: minY, z: minZ };
    const max = { x: maxX, y: maxY, z: maxZ };
    this.box = { min, max, size: subtract(max, min) };

    // 節點數上界要用「最小」葉大小算，不是最大的。
    //
    // 直覺會寫 2⌈n/LEAF_SIZE⌉，但那是葉子都塞滿時的數字。中位數切分只在 count > LEAF_SIZE
    // 時才切，count = 9 會切成 4 和 5 —— 所以最小的葉是 LEAF_SIZE/2 個三角形，
    // 節點數是那個估計的兩倍。算小了不會報錯：typed array 寫超出範圍是**靜默丟棄**，
    // 樹會少掉一整片子樹，查詢安靜地漏掉三角形，間隙就量出偏大的假數字。
    const minLeaf = Math.max(1, Math.floor(LEAF_SIZE / 2));
    const maxNodes = Math.max(1, 2 * Math.ceil(Math.max(count, 1) / minLeaf) + 2);
    this.#nodeBounds = new Float64Array(maxNodes * 6);
    this.#nodeRight = new Int32Array(maxNodes).fill(-1);
    this.#nodeStart = new Int32Array(maxNodes).fill(-1);
    this.#nodeCount = new Int32Array(maxNodes);
    this.#order = new Int32Array(count);
    for (let index = 0; index < count; index += 1) this.#order[index] = index;

    this.#nodeTotal = count === 0 ? 0 : this.#build(0, count, centroids, { next: 1 });
  }

  /**
   * 建樹：以最長軸的中位數切開。
   *
   * 用中位數（nth_element 式的分割）而不是空間中點，樹才會平衡 ——
   * 齒輪這種質量集中在圓環上的分佈，用空間中點切會生出一堆空節點。
   */
  #build(start: number, count: number, centroids: Float64Array, cursor: { next: number }): number {
    const self = cursor.next - 1;
    // 容量算錯的話 typed array 會靜默吃掉寫入，錯誤要到查詢結果才顯現，而且看起來像正確答案。
    // 寧可在這裡炸掉。
    if (self * 6 + 6 > this.#nodeBounds.length) {
      throw new Error(`BVH 節點容量不足：需要第 ${self} 個節點，只配置了 ${this.#nodeRight.length} 個。`);
    }
    const base = self * 6;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = start; i < start + count; i += 1) {
      const t = (this.#order[i] ?? 0) * 6;
      if ((this.#bounds[t] ?? 0) < minX) minX = this.#bounds[t] ?? 0;
      if ((this.#bounds[t + 1] ?? 0) < minY) minY = this.#bounds[t + 1] ?? 0;
      if ((this.#bounds[t + 2] ?? 0) < minZ) minZ = this.#bounds[t + 2] ?? 0;
      if ((this.#bounds[t + 3] ?? 0) > maxX) maxX = this.#bounds[t + 3] ?? 0;
      if ((this.#bounds[t + 4] ?? 0) > maxY) maxY = this.#bounds[t + 4] ?? 0;
      if ((this.#bounds[t + 5] ?? 0) > maxZ) maxZ = this.#bounds[t + 5] ?? 0;
    }

    this.#nodeBounds[base] = minX;
    this.#nodeBounds[base + 1] = minY;
    this.#nodeBounds[base + 2] = minZ;
    this.#nodeBounds[base + 3] = maxX;
    this.#nodeBounds[base + 4] = maxY;
    this.#nodeBounds[base + 5] = maxZ;

    if (count <= LEAF_SIZE) {
      this.#nodeStart[self] = start;
      this.#nodeCount[self] = count;
      this.#nodeRight[self] = -1;
      return cursor.next;
    }

    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    const axis = extentX >= extentY && extentX >= extentZ ? 0 : extentY >= extentZ ? 1 : 2;

    const slice = Array.from(this.#order.subarray(start, start + count));
    slice.sort((left, right) => (centroids[left * 3 + axis] ?? 0) - (centroids[right * 3 + axis] ?? 0));
    this.#order.set(slice, start);

    const half = Math.floor(count / 2);
    this.#nodeStart[self] = -1;
    this.#nodeCount[self] = 0;

    cursor.next += 1;
    this.#build(start, half, centroids, cursor);
    const right = cursor.next;
    this.#nodeRight[self] = right;
    cursor.next += 1;
    this.#build(start + half, count - half, centroids, cursor);
    return cursor.next;
  }

  /** 節點 AABB 與點 `p` 的距離下界。 */
  #nodeLowerBound(node: number, p: Vec3): number {
    const base = node * 6;
    const dx = Math.max(0, (this.#nodeBounds[base] ?? 0) - p.x, p.x - (this.#nodeBounds[base + 3] ?? 0));
    const dy = Math.max(0, (this.#nodeBounds[base + 1] ?? 0) - p.y, p.y - (this.#nodeBounds[base + 4] ?? 0));
    const dz = Math.max(0, (this.#nodeBounds[base + 2] ?? 0) - p.z, p.z - (this.#nodeBounds[base + 5] ?? 0));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** 節點 AABB 是否與 `box` 擴張 `radius` 後有交集。 */
  #nodeIntersectsBox(node: number, box: BoundingBox, radius: number): boolean {
    const base = node * 6;
    return (
      (this.#nodeBounds[base] ?? 0) <= box.max.x + radius &&
      (this.#nodeBounds[base + 3] ?? 0) >= box.min.x - radius &&
      (this.#nodeBounds[base + 1] ?? 0) <= box.max.y + radius &&
      (this.#nodeBounds[base + 4] ?? 0) >= box.min.y - radius &&
      (this.#nodeBounds[base + 2] ?? 0) <= box.max.z + radius &&
      (this.#nodeBounds[base + 5] ?? 0) >= box.min.z - radius
    );
  }

  /**
   * 三角形 index 的 AABB 與 `box` 的最小距離，不配置任何物件。
   *
   * `boundsOf(index)` 每次都要生出 min／max／size 三個物件；在「把所有三角形依遠近比較」
   * 這種每個三角形都要算一次、而且每組零件比對要算四次的路徑上，那就是幾百萬次配置。
   */
  lowerBoundToBox(index: number, box: BoundingBox): number {
    const base = index * 6;
    const dx = Math.max(0, (this.#bounds[base] ?? 0) - box.max.x, box.min.x - (this.#bounds[base + 3] ?? 0));
    const dy = Math.max(0, (this.#bounds[base + 1] ?? 0) - box.max.y, box.min.y - (this.#bounds[base + 4] ?? 0));
    const dz = Math.max(0, (this.#bounds[base + 2] ?? 0) - box.max.z, box.min.z - (this.#bounds[base + 5] ?? 0));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  boundsOf(index: number): BoundingBox {
    const base = index * 6;
    const min = {
      x: this.#bounds[base] ?? 0,
      y: this.#bounds[base + 1] ?? 0,
      z: this.#bounds[base + 2] ?? 0,
    };
    const max = {
      x: this.#bounds[base + 3] ?? 0,
      y: this.#bounds[base + 4] ?? 0,
      z: this.#bounds[base + 5] ?? 0,
    };
    return { min, max, size: subtract(max, min) };
  }

  /** 走訪 AABB 與 `box` 擴張 `radius` 後有交集的三角形。visit 回傳 true 就提早結束。 */
  forEachNear(box: BoundingBox, radius: number, visit: (index: number) => boolean | void): void {
    if (this.#nodeTotal === 0) return;
    const stack = [0];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      if (!this.#nodeIntersectsBox(node, box, radius)) continue;

      const start = this.#nodeStart[node] ?? -1;
      if (start >= 0) {
        const count = this.#nodeCount[node] ?? 0;
        for (let i = start; i < start + count; i += 1) {
          if (visit(this.#order[i] ?? 0) === true) return;
        }
        continue;
      }

      stack.push(node + 1);
      const right = this.#nodeRight[node] ?? -1;
      if (right >= 0) stack.push(right);
    }
  }

  /**
   * 找出離 `p` 最近、且距離小於 `limit` 的表面點。找不到就回 undefined。
   *
   * `limit` 必須是有限值 —— 傳 Infinity 代表沒有剪枝依據，整棵樹都得走。
   * 這是這支程式最早的版本跑不完的原因，所以在這裡擋掉而不是靠呼叫端自律。
   */
  nearestWithin(p: Vec3, limit: number): { readonly distance: number; readonly point: Vec3 } | undefined {
    if (!Number.isFinite(limit)) {
      throw new Error('nearestWithin 需要有限的搜尋上界；傳 Infinity 會讓剪枝失效。');
    }
    if (this.#nodeTotal === 0) return undefined;

    let best = limit;
    let bestPoint: Vec3 | undefined;

    // 明確的堆疊而不是遞迴：這條路徑一次比對會被呼叫上萬次，遞迴的呼叫成本看得出來。
    const stack: number[] = [0];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      if (this.#nodeLowerBound(node, p) >= best) continue;

      const start = this.#nodeStart[node] ?? -1;
      if (start >= 0) {
        const count = this.#nodeCount[node] ?? 0;
        for (let i = start; i < start + count; i += 1) {
          const index = this.#order[i] ?? 0;
          const base = index * 6;
          const dx = Math.max(0, (this.#bounds[base] ?? 0) - p.x, p.x - (this.#bounds[base + 3] ?? 0));
          const dy = Math.max(0, (this.#bounds[base + 1] ?? 0) - p.y, p.y - (this.#bounds[base + 4] ?? 0));
          const dz = Math.max(0, (this.#bounds[base + 2] ?? 0) - p.z, p.z - (this.#bounds[base + 5] ?? 0));
          if (dx * dx + dy * dy + dz * dz >= best * best) continue;

          const triangle = this.triangles[index];
          if (triangle === undefined) continue;
          const candidate = closestPointOnTriangle(p, triangle);
          const distance = distanceBetween(p, candidate);
          if (distance < best) {
            best = distance;
            bestPoint = candidate;
          }
        }
        continue;
      }

      // 先走比較近的子節點，best 收斂得快，另一邊往往整枝被剪掉。
      const left = node + 1;
      const right = this.#nodeRight[node] ?? -1;
      if (right < 0) {
        stack.push(left);
        continue;
      }
      const leftDistance = this.#nodeLowerBound(left, p);
      const rightDistance = this.#nodeLowerBound(right, p);
      if (leftDistance <= rightDistance) {
        if (rightDistance < best) stack.push(right);
        if (leftDistance < best) stack.push(left);
      } else {
        if (leftDistance < best) stack.push(left);
        if (rightDistance < best) stack.push(right);
      }
    }

    return bestPoint === undefined ? undefined : { distance: best, point: bestPoint };
  }
}
