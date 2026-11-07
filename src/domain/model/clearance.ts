import type { BoundingBox, Vec3 } from '../contracts.js';
import type { MeshPart } from './threemf-reader.js';
import type { Triangle } from './stl.js';
import {
  boxDistance,
  distanceBetween,
  dot,
  enclosesXY,
  scaleAdd,
  subtract,
  TriangleSet,
} from './triangle-set.js';
import { surfacesTouch } from './contact.js';

/**
 * Clearance measurement between parts.
 *
 * Why this exists: whether a print-in-place model (gears, hinges, ball joints) can move
 * depends on how much clearance is left between neighbouring parts, and on whether that
 * clearance is larger than what the printer can resolve. The slicer does not show this,
 * and neither does printability analysis (which only looks at the shape of a single solid),
 * yet it decides whether the result is "a mechanism that turns" or "a lump of fused plastic".
 *
 * Two deliberate design decisions:
 *
 * 1. **A part is not a solid.** Bambu also stores "one solid cut into height bands for a
 *    colour change" as separate parts. Comparing parts pairwise directly would report the
 *    upper and lower halves of the same gear as "clearance 0, will fuse", which is
 *    meaningless: they are the same piece to begin with. So parts that touch each other are
 *    first merged into rigid bodies, and rigid bodies are compared instead.
 *
 * 2. **What is measured is the minimum distance, not the centre distance.** The centre
 *    distance of two gears is easy to compute, but what actually fuses is the point where the
 *    tooth flanks come closest. Only sweeping the actual surfaces tells you where that point
 *    is and how far apart it is.
 */

export type ClosestApproach = {
  readonly distanceMm: number;
  readonly at: Vec3;
};

export type MinDistanceOptions = {
  /** Upper bound on sampling spacing, in mm. Smaller is more accurate and slower. */
  readonly samplingMm: number;
  /** Cap on the total number of sample points per comparison, so large models still finish. */
  readonly maxSamples: number;
};

export const DEFAULT_MIN_DISTANCE_OPTIONS: MinDistanceOptions = {
  samplingMm: 0.2,
  maxSamples: 250_000,
};

/**
 * Lay uniform sample points over a triangle (including its three vertices). Uses a fixed
 * barycentric grid so results are reproducible.
 */
function samplePoints(t: Triangle, spacing: number, maxSteps: number): readonly Vec3[] {
  const points: Vec3[] = [t.a, t.b, t.c];
  const ab = subtract(t.b, t.a);
  const ac = subtract(t.c, t.a);
  const longest = Math.sqrt(Math.max(dot(ab, ab), dot(ac, ac)));
  const steps = Math.min(maxSteps, Math.floor(longest / spacing));
  if (steps <= 1) return points;

  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; i + j <= steps; j += 1) {
      if (i === 0 && j === 0) continue;
      if (i === steps || j === steps) continue;
      points.push(scaleAdd(scaleAdd(t.a, ab, i / steps), ac, j / steps));
    }
  }
  return points;
}

/**
 * First obtain a finite upper bound.
 *
 * This step is not an optimisation, it is a precondition for correctness: spatial queries
 * need a finite search radius, otherwise they keep expanding ring after ring towards
 * infinity and the index becomes useless. Comparing a sample of triangles against each other
 * yields a good-enough upper bound in a few milliseconds.
 */
function seedUpperBound(a: TriangleSet, b: TriangleSet): number {
  const stride = (set: TriangleSet): number => Math.max(1, Math.floor(set.triangles.length / 120));
  const strideA = stride(a);
  const strideB = stride(b);

  let best = Infinity;
  for (let i = 0; i < a.triangles.length; i += strideA) {
    const ta = a.triangles[i];
    if (ta === undefined) continue;
    for (let j = 0; j < b.triangles.length; j += strideB) {
      const tb = b.triangles[j];
      if (tb === undefined) continue;
      const d = distanceBetween(ta.a, tb.a);
      if (d < best) best = d;
    }
  }

  if (Number.isFinite(best)) return best;
  // When both sides are empty or sampling picked nothing, fall back to the bounding-box
  // diagonals as the upper bound.
  const diagonal = (set: TriangleSet): number =>
    Math.sqrt(set.box.size.x ** 2 + set.box.size.y ** 2 + set.box.size.z ** 2);
  return diagonal(a) + diagonal(b) + boxDistance(a.box, b.box) + 1;
}

/**
 * Minimum distance between two triangle sets.
 *
 * Three stages: sample for an upper bound → vertex sweep to converge → surface sampling
 * refinement on triangles that are "close enough to the other side". Both directions are run,
 * because the closest point may lie inside a face on one side rather than on any vertex.
 *
 * Do not use this to ask "do they touch?"; that is `surfacesTouch` in contact.ts, two orders
 * of magnitude cheaper.
 */
export function minDistanceBetweenSets(
  a: TriangleSet,
  b: TriangleSet,
  options: MinDistanceOptions = DEFAULT_MIN_DISTANCE_OPTIONS,
): ClosestApproach | undefined {
  if (a.triangles.length === 0 || b.triangles.length === 0) return undefined;

  // The upper bound must be *strictly greater* than the true answer. Spatial queries only
  // report points closer than the bound; if the bound happens to equal the true answer (which
  // happens when sampling picks exactly the closest pair of vertices), every query returns
  // undefined and nothing is ever found. Add a little slack to step off the equality.
  const seed = seedUpperBound(a, b);
  let best = seed + Math.max(1e-6, seed * 1e-9);
  let bestPoint: Vec3 | undefined;

  const sweep = (source: TriangleSet, target: TriangleSet, spacing: number | undefined): void => {
    let budget = options.maxSamples;

    // Processing near-to-far is what makes branch-and-bound effective.
    //
    // Sweeping in file order, the first few thousand triangles may all be far from the other
    // side, so `best` never comes down, and a large `best` means the spatial query has to
    // search many rings outward, making every query expensive. Sort first, and the first
    // triangle processed is the most likely closest one: `best` immediately converges near
    // the true value and everything after it gets pruned. And because it is sorted, once the
    // lower bound exceeds `best` the whole loop can break without looking at the rest.
    const count = source.triangles.length;
    const lower = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      lower[index] = source.lowerBoundToBox(index, target.box);
    }
    // Do not sort the whole thing.
    //
    // Sorting looks natural (near-to-far is the cleanest branch-and-bound), but this path runs
    // four times per pair of parts, and the ring gear has 35,000 triangles: one comparison is
    // over a million comparator calls. Measured, half of the full 57-second run was spent here.
    //
    // All that is really needed is "process the closest few first to push `best` down". Once
    // it is down, everything else is rejected by the O(1) `lower >= best` check and order no
    // longer matters. Selecting the smallest K is linear; no O(n log n) needed.
    const SEED_COUNT = 48;
    const seedIndices: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const value = lower[index] ?? 0;
      if (seedIndices.length < SEED_COUNT) {
        seedIndices.push(index);
        if (seedIndices.length === SEED_COUNT) {
          seedIndices.sort((left, right) => (lower[left] ?? 0) - (lower[right] ?? 0));
        }
        continue;
      }
      const worst = seedIndices[SEED_COUNT - 1] ?? 0;
      if (value >= (lower[worst] ?? 0)) continue;
      seedIndices[SEED_COUNT - 1] = index;
      for (let k = SEED_COUNT - 1; k > 0; k -= 1) {
        const a = seedIndices[k] ?? 0;
        const b = seedIndices[k - 1] ?? 0;
        if ((lower[a] ?? 0) >= (lower[b] ?? 0)) break;
        seedIndices[k] = b;
        seedIndices[k - 1] = a;
      }
    }
    if (seedIndices.length < SEED_COUNT) {
      seedIndices.sort((left, right) => (lower[left] ?? 0) - (lower[right] ?? 0));
    }

    const visited = new Set(seedIndices);
    const order: number[] = [...seedIndices];
    for (let index = 0; index < count; index += 1) {
      if (!visited.has(index)) order.push(index);
    }

    for (const index of order) {
      const triangle = source.triangles[index];
      if (triangle === undefined) continue;
      if (budget <= 0) break;
      // Only the first SEED_COUNT entries are sorted; the rest are in original order, so this
      // is `continue`, not `break`.
      if ((lower[index] ?? 0) >= best) continue;

      let points: readonly Vec3[];
      if (spacing === undefined) {
        points = [triangle.a, triangle.b, triangle.c];
      } else {
        // Gate for the refinement stage.
        //
        // The AABB pruning above is not enough on its own: the other side's bounding box can be
        // huge (for example a whole ring gear), and "close to the bounding box" does not mean
        // "close to the surface". Without this gate, thousands of ring-gear triangles that are
        // actually far from the planet gear all get densely sampled; that is where the time
        // went.
        //
        // Ask once with the centroid first: if even "centroid to the other surface" exceeds
        // `best` plus this triangle's own radius, no point on the triangle can be closer than
        // `best`. One query replaces dozens of samples.
        const centroid = {
          x: (triangle.a.x + triangle.b.x + triangle.c.x) / 3,
          y: (triangle.a.y + triangle.b.y + triangle.c.y) / 3,
          z: (triangle.a.z + triangle.b.z + triangle.c.z) / 3,
        };
        const radius = Math.max(
          distanceBetween(centroid, triangle.a),
          distanceBetween(centroid, triangle.b),
          distanceBetween(centroid, triangle.c),
        );
        if (target.nearestWithin(centroid, best + radius) === undefined) continue;
        points = samplePoints(triangle, spacing, 6);
      }
      budget -= points.length;

      for (const point of points) {
        const hit = target.nearestWithin(point, best);
        if (hit === undefined) continue;
        best = hit.distance;
        // Report the midpoint of the two closest points: it sits in the middle of the gap,
        // which is easier to locate on the model.
        bestPoint = {
          x: (point.x + hit.point.x) / 2,
          y: (point.y + hit.point.y) / 2,
          z: (point.z + hit.point.z) / 2,
        };
      }
    }
  };

  sweep(a, b, undefined);
  sweep(b, a, undefined);

  // Refinement cannot be skipped just because the caller is "only grouping".
  //
  // It was tempting to drop it: grouping only asks a yes/no question, and coincident faces
  // always have some vertex lying on the other face. Interpenetrating parts are different: a
  // post pushed into a plate can have every vertex on both sides several mm from the other
  // surface, and the place where the distance is truly 0 is the line where the post's side
  // *crosses* the plate's top face, which only surface sampling reaches. Skipping refinement
  // would classify pins and embedded decorations as separate parts and then report a fake
  // "clearance".

  // Surface sampling refinement. Spacing is the smaller of "half the current best" and the
  // configured value, but not below 0.02 mm.
  const refine = Math.max(0.02, Math.min(options.samplingMm, best / 2));
  sweep(a, b, refine);
  sweep(b, a, refine);

  if (bestPoint === undefined) return undefined;
  return { distanceMm: best, at: bestPoint };
}

/** Convenience wrapper so callers holding only triangle arrays (e.g. tests) need not build the index. */
export function minDistanceBetween(
  a: readonly Triangle[],
  b: readonly Triangle[],
  options: MinDistanceOptions = DEFAULT_MIN_DISTANCE_OPTIONS,
): ClosestApproach | undefined {
  return minDistanceBetweenSets(new TriangleSet(a), new TriangleSet(b), options);
}

// ── Rigid-body grouping ───────────────────────────────────────────────────

export type RigidBody = {
  readonly index: number;
  readonly name: string;
  /** Names of the 3MF parts merged into this rigid body. */
  readonly partNames: readonly string[];
  readonly extruders: readonly string[];
  readonly triangleCount: number;
  readonly boundingBox: BoundingBox;
  readonly set: TriangleSet;
};

/**
 * Merge parts that touch each other into rigid bodies.
 *
 * The criterion is "minimum distance below fuseEpsilon". Colour-change bands cut from one
 * solid are exactly coincident (distance 0), and so are decorative balls embedded in a ring
 * (interpenetrating, distance 0), while genuinely separate mechanism parts are separated by a
 * design tolerance and are not merged by mistake; that is the 0.09 mm clearance measured on
 * the planetary-gear fidget spinner.
 */
export function groupRigidBodies(parts: readonly MeshPart[], fuseEpsilon = 1e-3): readonly RigidBody[] {
  const sets = parts.map((part) => new TriangleSet(part.triangles));
  const parent = parts.map((_, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (find(i) === find(j)) continue;
      const setI = sets[i];
      const setJ = sets[j];
      if (setI === undefined || setJ === undefined) continue;
      // If the AABBs do not even meet, they cannot touch. This line rejects the vast majority
      // of pairs.
      if (boxDistance(setI.box, setJ.box) > fuseEpsilon) continue;

      // Use the dedicated contact test; do not borrow the minimum distance.
      //
      // Borrowing it would compute an exact value to answer a yes/no question: the search
      // radius is "the current best" (possibly several mm), so the spatial query has to search
      // far outward. The contact test's radius is fixed at fuseEpsilon (on the order of a
      // micrometre), so almost every query looks at a single cell. Measured, this one change
      // cut grouping from several minutes to under a second.
      if (surfacesTouch(setI, setJ, fuseEpsilon)) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < parts.length; index += 1) {
    const root = find(index);
    const bucket = groups.get(root);
    if (bucket === undefined) groups.set(root, [index]);
    else bucket.push(index);
  }

  const bodies: RigidBody[] = [];
  let ordinal = 0;
  for (const members of groups.values()) {
    const memberParts = members
      .map((index) => parts[index])
      .filter((part): part is MeshPart => part !== undefined);
    const triangles = memberParts.flatMap((part) => part.triangles);
    if (triangles.length === 0) continue;

    const extruders = [
      ...new Set(
        memberParts
          .map((part) => part.extruder)
          .filter((value): value is string => value !== undefined),
      ),
    ].sort();

    const set = new TriangleSet(triangles);
    bodies.push({
      index: ordinal,
      name: memberParts[0]?.name ?? `body_${ordinal + 1}`,
      partNames: memberParts.map((part) => part.name),
      extruders,
      triangleCount: triangles.length,
      boundingBox: set.box,
      set,
    });
    ordinal += 1;
  }

  return bodies;
}

// ── Report ────────────────────────────────────────────────────────────────

export type ClearanceVerdict = 'will-fuse' | 'marginal' | 'adequate';

export type ClearancePair = {
  readonly a: string;
  readonly b: string;
  readonly gapMm: number;
  readonly at: Vec3;
  readonly verdict: ClearanceVerdict;
  /**
   * Which side encloses which at this interface.
   * `a-encloses-b` means the a side is a "hole" and is governed by xy_hole_compensation;
   * when neither encloses the other it is `neither`, and both sides are governed by
   * xy_contour_compensation.
   */
  readonly enclosure: 'a-encloses-b' | 'b-encloses-a' | 'neither';
};

export type ClearanceReport = {
  readonly format: string;
  readonly partCount: number;
  readonly bodies: readonly {
    readonly name: string;
    readonly partNames: readonly string[];
    readonly extruders: readonly string[];
    readonly triangleCount: number;
    readonly boundingBox: BoundingBox;
  }[];
  readonly pairs: readonly ClearancePair[];
  readonly tightestGapMm: number | undefined;
  readonly minimumClearanceMm: number;
  readonly findings: readonly string[];
  readonly recommendation:
    | {
        readonly xy_contour_compensation: string;
        readonly xy_hole_compensation: string;
        readonly rationale: string;
      }
    | undefined;
};

export type ClearanceOptions = {
  /**
   * Smallest clearance this machine/material can print reliably. The practical lower limit
   * for PLA on a 0.4 nozzle is about 0.15–0.20 mm.
   */
  readonly minimumClearanceMm: number;
  /** Pairs farther apart than this are left out of the report, so unrelated parts do not flood it. */
  readonly reportThresholdMm: number;
  /** Anything closer than this is treated as the same solid. */
  readonly fuseEpsilonMm: number;
};

export const DEFAULT_CLEARANCE_OPTIONS: ClearanceOptions = {
  minimumClearanceMm: 0.15,
  reportThresholdMm: 2,
  fuseEpsilonMm: 1e-3,
};

function verdictOf(gap: number, minimum: number): ClearanceVerdict {
  if (gap < minimum) return 'will-fuse';
  if (gap < minimum * 1.5) return 'marginal';
  return 'adequate';
}

export function analyseClearance(
  parts: readonly MeshPart[],
  format: string,
  options: ClearanceOptions = DEFAULT_CLEARANCE_OPTIONS,
  distanceOptions: MinDistanceOptions = DEFAULT_MIN_DISTANCE_OPTIONS,
): ClearanceReport {
  const bodies = groupRigidBodies(parts, options.fuseEpsilonMm);
  const pairs: ClearancePair[] = [];

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const bodyA = bodies[i];
      const bodyB = bodies[j];
      if (bodyA === undefined || bodyB === undefined) continue;
      if (boxDistance(bodyA.boundingBox, bodyB.boundingBox) > options.reportThresholdMm) continue;

      const hit = minDistanceBetweenSets(bodyA.set, bodyB.set, distanceOptions);
      if (hit === undefined || hit.distanceMm > options.reportThresholdMm) continue;

      pairs.push({
        a: bodyA.name,
        b: bodyB.name,
        gapMm: hit.distanceMm,
        at: hit.at,
        verdict: verdictOf(hit.distanceMm, options.minimumClearanceMm),
        enclosure: enclosesXY(bodyA.boundingBox, bodyB.boundingBox)
          ? 'a-encloses-b'
          : enclosesXY(bodyB.boundingBox, bodyA.boundingBox)
            ? 'b-encloses-a'
            : 'neither',
      });
    }
  }

  pairs.sort((left, right) => left.gapMm - right.gapMm);

  const tightest = pairs[0]?.gapMm;
  const findings: string[] = [];

  if (bodies.length <= 1) {
    findings.push(
      'Only one solid was found, so there are no parts that can move relative to each other. ' +
        'Either this model is not a print-in-place mechanism, or all of its parts are joined by design.',
    );
  }

  const fusing = pairs.filter((pair) => pair.verdict === 'will-fuse');
  const marginal = pairs.filter((pair) => pair.verdict === 'marginal');

  if (fusing.length > 0) {
    findings.push(
      `${fusing.length} interface(s) have a clearance below ${options.minimumClearanceMm} mm ` +
        'and will fuse if printed at the original size. Forcing them apart is possible, but the ' +
        'tooth flanks will tear and the motion will not be smooth.',
    );
  }
  if (marginal.length > 0) {
    findings.push(
      `${marginal.length} interface(s) are in the marginal range; whether they move depends on ` +
        'how much the first layer is squished and on flow calibration.',
    );
  }
  if (pairs.length > 0 && fusing.length === 0 && marginal.length === 0) {
    findings.push(
      'Every interface has a clearance in the reliable range; no compensation is needed for the parts to turn.',
    );
  }

  let recommendation: ClearanceReport['recommendation'];
  if (tightest !== undefined && tightest < options.minimumClearanceMm) {
    // Shrink/grow each side by this much so the two sides together just reach the threshold.
    // Quantised to 0.005 mm steps so it can be typed straight into Studio.
    //
    // The 1e-9 is not decoration: 0.15 - 0.09 in floating point is 0.06000000000000005, times
    // 200 is 6.000000000000005, and ceil rounds that up to 7, inflating an exact 0.030 to
    // 0.035. The recommendation would give away an extra 0.005 mm for nothing, eating into
    // tooth thickness.
    const perSide = Math.ceil(((options.minimumClearanceMm - tightest) / 2) * 200 - 1e-9) / 200;
    const hasEnclosure = pairs.some(
      (pair) => pair.verdict === 'will-fuse' && pair.enclosure !== 'neither',
    );
    recommendation = {
      xy_contour_compensation: `-${perSide.toFixed(3)}`,
      xy_hole_compensation: hasEnclosure ? `${perSide.toFixed(3)}` : '0',
      rationale:
        `The tightest interface is ${tightest.toFixed(3)} mm against a target of ${options.minimumClearanceMm} mm; ` +
        `giving up ${perSide.toFixed(3)} mm on each side closes the difference exactly.` +
        (hasEnclosure
          ? ' Note that one part is enclosed by another: to the slicer, the enclosing side of that ' +
            'interface is a "hole", governed by xy_hole_compensation (positive values enlarge it), ' +
            'not xy_contour_compensation. Adjust only one of them and the clearance grows by only half.'
          : ' There is no enclosure, so both sides are outer contours; only xy_contour_compensation needs adjusting.') +
        ' Also make sure detect_thin_wall is off; with it on, the slicer will try to fill these gaps.',
    };
  }

  return {
    format,
    partCount: parts.length,
    bodies: bodies.map((body) => ({
      name: body.name,
      partNames: body.partNames,
      extruders: body.extruders,
      triangleCount: body.triangleCount,
      boundingBox: body.boundingBox,
    })),
    pairs,
    tightestGapMm: tightest,
    minimumClearanceMm: options.minimumClearanceMm,
    findings,
    recommendation,
  };
}
