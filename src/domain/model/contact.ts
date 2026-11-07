import type { Vec3 } from '../contracts.js';
import type { Triangle } from './stl.js';
import { boxDistance, distanceBetween, dot, subtract, TriangleSet } from './triangle-set.js';

/**
 * Contact test: are two triangle sets parts of the same solid?
 *
 * This is a different question from "minimum distance", and much cheaper. Minimum distance
 * has to find the exact value, so it must sweep every place that could be closer; the contact
 * test only answers yes/no, stops as soon as it finds evidence, and its search radius is fixed
 * at that tiny tolerance, so the spatial query almost always looks at a single cell.
 *
 * "Same solid" comes in two forms, and both must be recognised:
 *
 * 1. **Coincident**: like a colour-change cut, two faces overlap exactly at distance 0. A
 *    distance query catches this.
 * 2. **Interpenetrating**: a pin pushed into a hole, a decorative ball embedded in a ring. Here
 *    the vertices on both sides may be several mm from the other surface, and the place where
 *    the distance is truly 0 is the line where the two faces *cross*. A distance query misses
 *    it; an intersection test is needed.
 */

/**
 * Segment–triangle intersection (Möller–Trumbore).
 *
 * Returns whether the intersection point lies on the segment (t ∈ [0, 1]) and inside the
 * triangle. A segment parallel to the triangle's plane returns false; that case is coplanar
 * and is caught by the distance-query path instead.
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
 * Whether two triangles intersect.
 *
 * Decided by testing each of the six edges as a segment against the other triangle. A
 * non-coplanar intersection always makes at least one edge pass through the other triangle,
 * so these six tests are complete; the coplanar case has distance 0 and is left to the
 * caller's distance query.
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
 * Whether two triangle sets touch within `epsilon` or interpenetrate.
 *
 * Returns true as soon as evidence is found. Every search radius is fixed at epsilon, so
 * spatial pruning is very effective; that is why this is two orders of magnitude faster than
 * "compute the exact minimum distance and compare".
 */
export function surfacesTouch(a: TriangleSet, b: TriangleSet, epsilon: number): boolean {
  if (a.triangles.length === 0 || b.triangles.length === 0) return false;
  if (boxDistance(a.box, b.box) > epsilon) return false;

  // Use the side with fewer triangles as the source and the larger side as the query target,
  // so fewer scans are needed.
  const [source, target] =
    a.triangles.length <= b.triangles.length ? ([a, b] as const) : ([b, a] as const);

  let touching = false;

  for (let index = 0; index < source.triangles.length && !touching; index += 1) {
    const triangle = source.triangles[index];
    if (triangle === undefined) continue;
    const box = source.boundsOf(index);
    if (boxDistance(box, target.box) > epsilon) continue;

    // 1. Coincident: a vertex lies on the other surface.
    for (const vertex of [triangle.a, triangle.b, triangle.c]) {
      const hit = target.nearestWithin(vertex, epsilon);
      if (hit !== undefined) {
        touching = true;
        break;
      }
    }
    if (touching) break;

    // 2. Interpenetrating: an edge crosses a face on the other side. Only candidates whose
    //    AABBs overlap are tested.
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

/** For tests and diagnostics: reports whether two triangles intersect. */
export const trianglesIntersectForTest = trianglesIntersect;

/** For tests: segment–triangle intersection. */
export const segmentHitsTriangleForTest = segmentHitsTriangle;

/** Re-export of a geometry helper so contact-test users need not import triangle-set as well. */
export { distanceBetween };
