import type { BoundingBox, Vec3 } from '../contracts.js';
import { groupRigidBodies, minDistanceBetweenSets, type RigidBody } from './clearance.js';
import { boundingBox, type Triangle } from './stl.js';
import type { MeshPart } from './threemf-reader.js';
import { boxDistance, dot, subtract } from './triangle-set.js';

/**
 * Floating-solid detection: which solids do not reach the plate.
 *
 * The real case that hit this (2026-11-07, a birthday-cake topper): a model built from ten
 * boxes in Tinkercad, with two legs ending at z=50 and the body starting at z=51. The 1 mm gap
 * in between is invisible to the eye. Bambu Studio reports
 * "Levitating objects cannot be printed without supports", but simply enabling supports is
 * wrong: the support fills that gap, and once it is removed the legs and body come apart.
 *
 * Neither the overall bounding box nor overhang angles catch this: the model's lowest point
 * really is on the plate (the legs), and every face angle is normal. What matters is
 * **connectivity**: split the geometry into shells, merge shells that touch or interpenetrate
 * into solids, then check whether each solid reaches the plate.
 *
 * Three levels of merging:
 * 1. Shell: triangles that share vertices belong to the same shell (one Tinkercad primitive).
 * 2. Contact: shells whose surfaces coincide or interpenetrate are the same solid (delegated to
 *    groupRigidBodies, the same criterion as clearance measurement).
 * 3. Containment: a shell hidden entirely inside another solid (e.g. an eye enclosed by a
 *    banner) has no surface contact at all, but is absorbed by the union at slicing time and
 *    must not be reported as floating. Decided with a ray parity test.
 */

export type FloatingBody = {
  readonly name: string;
  readonly partNames: readonly string[];
  readonly boundingBox: BoundingBox;
  /** Height of this solid's lowest point above the plate. */
  readonly liftMm: number;
  /** The nearest other solid (usually the one it should be attached to). */
  readonly nearestBody: string | undefined;
  /** Minimum distance to the nearest solid; this is the width of the gap. */
  readonly gapMm: number | undefined;
  readonly gapAt: Vec3 | undefined;
};

export type FloatingReport = {
  readonly bodyCount: number;
  readonly groundedBodyCount: number;
  readonly floating: readonly FloatingBody[];
};

export type FloatingOptions = {
  /** A solid whose lowest point is within this distance of the plate counts as grounded. */
  readonly bedToleranceMm: number;
  /** Anything closer than this counts as contact. */
  readonly fuseEpsilonMm: number;
  /** When looking for the nearest solid, skip candidates whose bounding boxes are farther than this. */
  readonly neighbourSearchMm: number;
};

export const DEFAULT_FLOATING_OPTIONS: FloatingOptions = {
  bedToleranceMm: 0.01,
  fuseEpsilonMm: 1e-3,
  neighbourSearchMm: 20,
};

// ── Shells ──────────────────────────────────────────────────────────────

const QUANTUM = 1e5;

function vertexKey(v: Vec3): string {
  return `${Math.round(v.x * QUANTUM)},${Math.round(v.y * QUANTUM)},${Math.round(v.z * QUANTUM)}`;
}

/**
 * Split triangles into connected shells by shared vertices.
 *
 * An STL is one big triangle soup, yet each primitive in a Tinkercad export is still its own
 * shell; a single part in 3MF/OBJ can also contain several shells (e.g. each letter of a text).
 */
export function splitShells(triangles: readonly Triangle[]): readonly (readonly Triangle[])[] {
  const ids = new Map<string, number>();
  const parent: number[] = [];

  const idOf = (v: Vec3): number => {
    const key = vertexKey(v);
    let id = ids.get(key);
    if (id === undefined) {
      id = parent.length;
      ids.set(key, id);
      parent.push(id);
    }
    return id;
  };
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    // Path compression: without it, large meshes (hundreds of thousands of vertices)
    // degenerate into linear chains.
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor] ?? root;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const corners = triangles.map((t) => [idOf(t.a), idOf(t.b), idOf(t.c)] as const);
  for (const [a, b, c] of corners) {
    union(a, b);
    union(b, c);
  }

  const shells = new Map<number, Triangle[]>();
  triangles.forEach((triangle, index) => {
    const root = find(corners[index]?.[0] ?? 0);
    const bucket = shells.get(root);
    if (bucket === undefined) shells.set(root, [triangle]);
    else bucket.push(triangle);
  });

  return [...shells.values()];
}

// ── Containment ─────────────────────────────────────────────────────────

/**
 * Whether a point is inside a closed mesh (ray parity test).
 *
 * The ray direction is deliberately not aligned with any axis: an axis-aligned ray easily
 * grazes exactly along a box edge or vertex, an edge then gets counted once by each of its two
 * triangles, and the parity comes out wrong.
 */
const RAY = (() => {
  const raw = { x: 0.1234, y: 0.2345, z: 0.9643 };
  const length = Math.sqrt(dot(raw, raw));
  return { x: raw.x / length, y: raw.y / length, z: raw.z / length };
})();

function rayHits(origin: Vec3, t: Triangle): boolean {
  const edge1 = subtract(t.b, t.a);
  const edge2 = subtract(t.c, t.a);
  const h = {
    x: RAY.y * edge2.z - RAY.z * edge2.y,
    y: RAY.z * edge2.x - RAY.x * edge2.z,
    z: RAY.x * edge2.y - RAY.y * edge2.x,
  };
  const determinant = dot(edge1, h);
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant;
  const s = subtract(origin, t.a);
  const u = inverse * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = {
    x: s.y * edge1.z - s.z * edge1.y,
    y: s.z * edge1.x - s.x * edge1.z,
    z: s.x * edge1.y - s.y * edge1.x,
  };
  const v = inverse * dot(RAY, q);
  if (v < 0 || u + v > 1) return false;
  return inverse * dot(edge2, q) > 1e-9;
}

export function pointInsideMesh(point: Vec3, triangles: readonly Triangle[]): boolean {
  let crossings = 0;
  for (const triangle of triangles) {
    if (rayHits(point, triangle)) crossings += 1;
  }
  return crossings % 2 === 1;
}

function boxContains(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    outer.min.x <= inner.min.x &&
    outer.min.y <= inner.min.y &&
    outer.min.z <= inner.min.z &&
    outer.max.x >= inner.max.x &&
    outer.max.y >= inner.max.y &&
    outer.max.z >= inner.max.z
  );
}

// ── Main flow ───────────────────────────────────────────────────────────

/**
 * Only parts that will actually be printed count; negative volumes, modifiers and
 * support blockers/enforcers are not solids.
 */
function isSolid(part: MeshPart): boolean {
  return part.subtype === undefined || part.subtype === 'normal_part';
}

export function findFloatingBodies(
  parts: readonly MeshPart[],
  options: FloatingOptions = DEFAULT_FLOATING_OPTIONS,
): FloatingReport {
  // Shell names must be unique: grouping returns only names, and shells are mapped back by
  // name. Parts with duplicate names are common in 3MF.
  const used = new Map<string, number>();
  const unique = (name: string): string => {
    const count = used.get(name) ?? 0;
    used.set(name, count + 1);
    return count === 0 ? name : `${name}~${count + 1}`;
  };
  const shells: MeshPart[] = parts.filter(isSolid).flatMap((part) => {
    const pieces = splitShells(part.triangles);
    return pieces.map((triangles, index) => ({
      ...part,
      name: unique(pieces.length === 1 ? part.name : `${part.name}#${index + 1}`),
      triangles,
    }));
  });
  const shellBoxes = shells.map((shell) => boundingBox(shell.triangles));

  const bodies = groupRigidBodies(shells, options.fuseEpsilonMm);
  if (bodies.length === 0) return { bodyCount: 0, groundedBodyCount: 0, floating: [] };

  const bodyOfShell = new Map<string, number>();
  bodies.forEach((body, index) => {
    for (const name of body.partNames) bodyOfShell.set(name, index);
  });

  const bedZ = Math.min(...bodies.map((body) => body.boundingBox.min.z));

  // Containment: a solid entirely enclosed by another solid counts as the same piece as the
  // outer one.
  //
  // The parity test must be done per *shell*, not by counting all of a solid's triangles. A
  // solid is often several interpenetrating closed shells (Tinkercad boxes stacked together);
  // when a point lies inside two overlapping shells at once, the crossing count is
  // odd + odd = even and the point is wrongly judged to be outside. Observed on a real model:
  // letters enclosed by a banner were reported as floating because of this.
  const parent = bodies.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  for (let i = 0; i < bodies.length; i += 1) {
    const inner = bodies[i];
    const probe = inner?.set.triangles[0]?.a;
    if (inner === undefined || probe === undefined) continue;
    for (let k = 0; k < shells.length; k += 1) {
      const shell = shells[k];
      const box = shellBoxes[k];
      const j = shell === undefined ? undefined : bodyOfShell.get(shell.name);
      if (shell === undefined || box === undefined || j === undefined || j === i) continue;
      if (!boxContains(box, inner.boundingBox)) continue;
      if (pointInsideMesh(probe, shell.triangles)) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootI] = rootJ;
        break;
      }
    }
  }

  const clusters = new Map<number, RigidBody[]>();
  bodies.forEach((body, index) => {
    const root = find(index);
    const bucket = clusters.get(root);
    if (bucket === undefined) clusters.set(root, [body]);
    else bucket.push(body);
  });

  const grounded = new Set<RigidBody>();
  const floatingClusters: RigidBody[][] = [];
  for (const members of clusters.values()) {
    const lowest = Math.min(...members.map((body) => body.boundingBox.min.z));
    if (lowest - bedZ <= options.bedToleranceMm) for (const body of members) grounded.add(body);
    else floatingClusters.push(members);
  }

  const floating: FloatingBody[] = floatingClusters.map((members) => {
    // Take the name and bounding box from the outer piece: in a containment merge the
    // enclosed pieces go last.
    const sorted = [...members].sort(
      (left, right) => right.set.triangles.length - left.set.triangles.length,
    );
    const main = sorted[0] as RigidBody;
    const lowest = Math.min(...members.map((body) => body.boundingBox.min.z));

    // For the nearest solid, prefer ones that stand on the plate: that is what it should be
    // attached to. Otherwise two floating letters would point at each other and report a gap
    // unrelated to the problem.
    const nearestAmong = (candidates: readonly RigidBody[]) => {
      let best: { body: RigidBody; distanceMm: number; at: Vec3 } | undefined;
      for (const other of candidates) {
        if (boxDistance(main.boundingBox, other.boundingBox) > options.neighbourSearchMm) continue;
        const hit = minDistanceBetweenSets(main.set, other.set);
        if (hit !== undefined && (best === undefined || hit.distanceMm < best.distanceMm)) {
          best = { body: other, distanceMm: hit.distanceMm, at: hit.at };
        }
      }
      return best;
    };
    const nearest =
      nearestAmong([...grounded]) ?? nearestAmong(bodies.filter((body) => !members.includes(body)));
    const nearestBody = nearest?.body.name;
    const gapMm = nearest?.distanceMm;
    const gapAt = nearest?.at;

    return {
      name: main.name,
      partNames: members.flatMap((body) => body.partNames),
      boundingBox: main.boundingBox,
      liftMm: lowest - bedZ,
      nearestBody,
      gapMm,
      gapAt,
    };
  });

  floating.sort((left, right) => left.liftMm - right.liftMm);

  return {
    bodyCount: clusters.size,
    groundedBodyCount: clusters.size - floatingClusters.length,
    floating,
  };
}
