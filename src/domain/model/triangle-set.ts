import type { BoundingBox, Vec3 } from '../contracts.js';
import type { Triangle } from './stl.js';

/**
 * A set of triangles with a BVH (bounding volume hierarchy) for queries.
 *
 * It was split out of `clearance.ts` for performance: the index used to be rebuilt for every
 * pair of parts compared, and the ring gear of the planetary-gear fidget spinner has over
 * 30,000 triangles and is compared against each of nine parts. The index belongs with the
 * data and should be built only once.
 *
 * Why a BVH rather than a uniform grid: the first version used a grid, and a CPU profile
 * showed **96% of the time spent in `nearestWithin` itself, not in geometry computation**;
 * in other words, all the time went into "scanning one empty cell after another". A uniform
 * grid is the wrong structure for this data: gears are thin shells, triangles cluster on the
 * surface, and most cells are empty; and once the search radius grows a little, the number of
 * cells to scan grows with the square of the radius. A BVH prunes at every level using the
 * actually occupied extent, so empty space is never visited at all.
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
 * Closest point on a triangle to a point (Ericson, Real-Time Collision Detection §5.1.5).
 *
 * Approximating with vertex-to-vertex distance overestimates: for two flat tooth flanks facing
 * each other, the closest pair may lie inside the faces rather than on any vertex. Print-in-place
 * tolerances are only around 0.1 mm, and overestimating by 0.05 mm is enough to misjudge
 * "will fuse" as "safe", so this computes the true point-to-face distance.
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

/** Minimum distance between two AABBs; 0 when they overlap. A lower bound for pruning that never overestimates. */
export function boxDistance(a: BoundingBox, b: BoundingBox): number {
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Whether bounding box `outer` fully encloses `inner` in the XY plane. */
export function enclosesXY(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    outer.min.x <= inner.min.x &&
    outer.min.y <= inner.min.y &&
    outer.max.x >= inner.max.x &&
    outer.max.y >= inner.max.y
  );
}

/** Maximum triangles per BVH leaf. Too small makes the tree too deep; too large makes pruning coarse. */
const LEAF_SIZE = 8;

export class TriangleSet {
  readonly triangles: readonly Triangle[];
  /** Per-triangle AABBs, flattened into groups of 6 floats. A typed array avoids tens of thousands of small objects. */
  readonly #bounds: Float64Array;
  readonly box: BoundingBox;

  /** BVH node AABBs, also groups of 6 floats. */
  readonly #nodeBounds: Float64Array;
  /** Internal nodes: index of the right child (the left child is always self + 1). -1 for leaves. */
  readonly #nodeRight: Int32Array;
  /** Start and count of a leaf's range in #order; -1 / 0 for internal nodes. */
  readonly #nodeStart: Int32Array;
  readonly #nodeCount: Int32Array;
  /** Permutation of triangle indices; leaves point at contiguous ranges in it. */
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

    // The upper bound on node count must use the *smallest* leaf size, not the largest.
    //
    // The intuitive formula is 2⌈n/LEAF_SIZE⌉, but that assumes every leaf is full. Median
    // splitting only splits when count > LEAF_SIZE, and count = 9 splits into 4 and 5, so the
    // smallest leaf holds LEAF_SIZE/2 triangles and the node count is twice that estimate.
    // Underestimating raises no error: out-of-range writes to a typed array are **silently
    // dropped**, the tree loses an entire subtree, queries quietly miss triangles, and the
    // measured clearance comes out as a falsely large number.
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
   * Build the tree: split at the median along the longest axis.
   *
   * Splitting at the median (an nth_element-style partition) rather than the spatial midpoint
   * keeps the tree balanced; for a gear, whose mass is concentrated on a ring, splitting at the
   * spatial midpoint produces lots of empty nodes.
   */
  #build(start: number, count: number, centroids: Float64Array, cursor: { next: number }): number {
    const self = cursor.next - 1;
    // If the capacity is miscalculated, the typed array silently swallows writes, and the error
    // only surfaces in query results, where it looks like a correct answer. Better to blow up here.
    if (self * 6 + 6 > this.#nodeBounds.length) {
      throw new Error(
        `BVH node capacity exceeded: node ${self} is needed but only ${this.#nodeRight.length} were allocated.`,
      );
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

  /** Lower bound on the distance between a node's AABB and point `p`. */
  #nodeLowerBound(node: number, p: Vec3): number {
    const base = node * 6;
    const dx = Math.max(0, (this.#nodeBounds[base] ?? 0) - p.x, p.x - (this.#nodeBounds[base + 3] ?? 0));
    const dy = Math.max(0, (this.#nodeBounds[base + 1] ?? 0) - p.y, p.y - (this.#nodeBounds[base + 4] ?? 0));
    const dz = Math.max(0, (this.#nodeBounds[base + 2] ?? 0) - p.z, p.z - (this.#nodeBounds[base + 5] ?? 0));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Whether a node's AABB intersects `box` expanded by `radius`. */
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
   * Minimum distance between triangle `index`'s AABB and `box`, without allocating any objects.
   *
   * `boundsOf(index)` creates three objects (min/max/size) on every call; on a path like
   * "rank every triangle by distance", which runs once per triangle and four times per pair of
   * parts, that adds up to millions of allocations.
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

  /** Visit triangles whose AABB intersects `box` expanded by `radius`. Stops early when visit returns true. */
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
   * Find the surface point closest to `p` whose distance is less than `limit`. Returns
   * undefined if there is none.
   *
   * `limit` must be finite: passing Infinity leaves nothing to prune against, so the whole tree
   * has to be walked. That is why the earliest version of this code never finished, so it is
   * rejected here rather than relying on caller discipline.
   */
  nearestWithin(p: Vec3, limit: number): { readonly distance: number; readonly point: Vec3 } | undefined {
    if (!Number.isFinite(limit)) {
      throw new Error('nearestWithin requires a finite search bound; passing Infinity disables pruning.');
    }
    if (this.#nodeTotal === 0) return undefined;

    let best = limit;
    let bestPoint: Vec3 | undefined;

    // An explicit stack rather than recursion: this path is called tens of thousands of times
    // per comparison, and the cost of recursive calls is measurable.
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

      // Visit the nearer child first: `best` converges quickly and the other branch is often
      // pruned entirely.
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
