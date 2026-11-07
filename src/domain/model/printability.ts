import type { PrintabilityFinding, PrintabilityReport, Vec3 } from '../contracts.js';
import { findFloatingBodies, type FloatingBody } from './floating.js';
import { boundingBox, faceNormal, inspectModel, triangleArea, type Triangle } from './stl.js';
import type { MeshPart } from './threemf-reader.js';

/**
 * Printability analysis.
 *
 * This covers "problems visible before slicing", not a full slicing simulation.
 * Every check states its criterion and its blind spots; uncertain things are never dressed up
 * as certain.
 *
 * Overhang angle convention: expressed as **the angle from vertical**.
 * A vertical wall = 0°, a horizontal downward-facing ceiling = 90°. The larger the angle, the
 * more it needs support. This convention does not necessarily match the numeric value of
 * `support_threshold_angle` in the BambuStudio UI, so the report only says "how steep it is
 * geometrically" and does not claim directly whether Studio will add support.
 */

export type PrintabilityOptions = {
  /** Printer build volume, in mm. */
  readonly buildVolume: Vec3;
  /** Overhangs steeper than this angle are flagged. */
  readonly overhangThresholdDegrees: number;
  /** Currently configured extrusion line width, used to judge whether features are too thin. */
  readonly lineWidthMm: number;
};

export const DEFAULT_PRINTABILITY_OPTIONS: PrintabilityOptions = {
  // Actual build volume of the Bambu Lab P1S / X1C.
  buildVolume: { x: 256, y: 256, z: 256 },
  overhangThresholdDegrees: 45,
  lineWidthMm: 0.42,
};

/**
 * A gap narrower than this is almost certainly a modelling join that was missed, not an
 * intentionally floating design. Being one grid-snap step (1 mm) off when assembling boxes in
 * Tinkercad is exactly this order of magnitude.
 */
const SEAM_GAP_MM = 2;

/**
 * @param parts The file's own part boundaries (3MF/OBJ). If omitted, the whole triangle set is
 *   treated as one part; floating detection splits it into shells by shared vertices anyway, so
 *   STL files are caught too.
 */
export function analysePrintability(
  triangles: readonly Triangle[],
  options: PrintabilityOptions = DEFAULT_PRINTABILITY_OPTIONS,
  parts?: readonly MeshPart[],
): PrintabilityReport {
  const inspection = inspectModel(triangles);
  const box = boundingBox(triangles);
  const findings: PrintabilityFinding[] = [];

  const fitsBuildVolume =
    box.size.x <= options.buildVolume.x &&
    box.size.y <= options.buildVolume.y &&
    box.size.z <= options.buildVolume.z;

  if (!fitsBuildVolume) {
    const scale = Math.min(
      options.buildVolume.x / box.size.x,
      options.buildVolume.y / box.size.y,
      options.buildVolume.z / box.size.z,
    );
    findings.push({
      code: 'exceeds-build-volume',
      severity: 'blocker',
      summary: `Model ${fmt(box.size)} mm exceeds the build volume ${fmt(options.buildVolume)} mm`,
      detail:
        `It only fits when scaled to ${(scale * 100).toFixed(1)}% or less; ` +
        'alternatively rotate it, or cut the model and print it in pieces.',
      relatedParameters: [],
    });
  }

  if (!inspection.closed) {
    findings.push({
      code: 'non-manifold',
      severity: 'warning',
      summary: `Mesh is not closed: ${inspection.openEdges} edge(s) are not shared by exactly two triangles`,
      detail:
        'The slicer may still print it, but inside/outside classification will go wrong, which can ' +
        'cause missing faces, solids turning hollow, or extra internal walls. ' +
        'The real fix is to repair the mesh (Blender 3D Print Toolbox or Netfabb), not to compensate with slicer settings.',
      relatedParameters: [],
    });
  }

  if (inspection.degenerateTriangles > 0) {
    findings.push({
      code: 'degenerate-geometry',
      severity: 'note',
      summary: `${inspection.degenerateTriangles} triangle(s) have zero area`,
      detail:
        'Usually leftovers from export and generally harmless, but they make mesh repair tools report false positives.',
      relatedParameters: [],
    });
  }

  const floatingReport = findFloatingBodies(
    parts ?? [{ name: 'model', partId: '1', extruder: undefined, triangles }],
  );
  const floating = floatingReport.floating;
  if (floating.length > 0) {
    findings.push(floatingFinding(floating));
  }

  const overhang = measureOverhang(triangles, options.overhangThresholdDegrees, box.min.z);
  if (overhang.ratio > 0.02) {
    const severity = overhang.ratio > 0.2 ? 'warning' : 'note';
    findings.push({
      code: 'steep-overhang',
      severity,
      summary: `${(overhang.ratio * 100).toFixed(1)}% of the surface area is downward-facing overhang steeper than ${options.overhangThresholdDegrees}°`,
      detail:
        `The steepest point reaches ${overhang.maxDegrees.toFixed(1)}° (90° is a perfectly horizontal ceiling). ` +
        'Try a different orientation first; enable support only when no orientation works.',
      relatedParameters: [
        'enable_support',
        'support_type',
        'support_threshold_angle',
        'enable_overhang_speed',
      ],
    });
  }

  const footprint = measureFootprintArea(triangles, box);
  const footprintRatio = footprint / Math.max(box.size.x * box.size.y, 1e-6);
  if (footprintRatio < 0.15 && box.size.z > 20) {
    findings.push({
      code: 'small-footprint',
      severity: 'warning',
      summary: `Bed contact area is only about ${footprint.toFixed(1)} mm², ${(footprintRatio * 100).toFixed(1)}% of the projected area`,
      detail: 'Tall parts with a small contact area are easily knocked over by the nozzle or lift off the bed during printing.',
      relatedParameters: ['brim_type', 'brim_width', 'hot_plate_temp_initial_layer'],
    });
  }

  const base = Math.max(Math.min(box.size.x, box.size.y), 1e-6);
  const aspect = box.size.z / base;
  if (aspect > 5) {
    findings.push({
      code: 'tall-and-narrow',
      severity: 'note',
      summary: `Height-to-width ratio is about ${aspect.toFixed(1)}:1`,
      detail:
        'Tall, slender parts wobble during fast moves, causing ringing on the upper half or even breakage. ' +
        'Lowering outer wall speed and acceleration helps noticeably.',
      relatedParameters: ['outer_wall_speed', 'default_acceleration', 'brim_type'],
    });
  }

  const minDimension = Math.min(box.size.x, box.size.y, box.size.z);
  if (minDimension < options.lineWidthMm * 2) {
    findings.push({
      code: 'thin-feature',
      severity: 'warning',
      summary: `Smallest overall dimension ${minDimension.toFixed(2)} mm is less than two extrusion line widths (${(options.lineWidthMm * 2).toFixed(2)} mm)`,
      detail:
        'At this thickness the slicer may skip the whole section. ' +
        'Note that this only checks the overall bounding box; thin walls inside the model only show up ' +
        'after actually slicing, and this check does not cover them.',
      relatedParameters: ['line_width', 'detect_thin_wall', 'layer_height'],
    });
  }

  const flatArea = box.size.x * box.size.y;
  if (flatArea > 10000 && footprintRatio > 0.6) {
    findings.push({
      code: 'large-flat-area',
      severity: 'note',
      summary: `Large bed contact area (about ${(flatArea * footprintRatio).toFixed(0)} mm²)`,
      detail:
        'Shrinkage stress on a large flat bottom concentrates at the corners; this is the classic shape for warping. ' +
        'Take particular care with high-shrinkage materials.',
      relatedParameters: ['brim_type', 'hot_plate_temp_initial_layer', 'fan_max_speed', 'draft_shield'],
    });
  }

  return {
    inspection,
    buildVolume: options.buildVolume,
    fitsBuildVolume,
    overhangAreaRatio: overhang.ratio,
    floatingBodies: floating.map((body) => ({
      name: body.name,
      partNames: body.partNames,
      liftMm: body.liftMm,
      nearestBody: body.nearestBody,
      gapMm: body.gapMm,
      gapAt: body.gapAt,
    })),
    findings: findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
  };
}

function floatingFinding(floating: readonly FloatingBody[]): PrintabilityFinding {
  const seams = floating.filter((body) => body.gapMm !== undefined && body.gapMm <= SEAM_GAP_MM);
  const allSeams = seams.length === floating.length;
  const narrowest = Math.min(...floating.map((body) => body.gapMm ?? Infinity));

  const lines = floating.map((body) => {
    const where =
      body.gapMm === undefined || body.nearestBody === undefined
        ? 'no other solid nearby'
        : `with a ${body.gapMm.toFixed(3)} mm gap to "${body.nearestBody}"`;
    return `"${body.name}" has its lowest point ${body.liftMm.toFixed(2)} mm above the plate, ${where}`;
  });

  const advice = allSeams
    ? `These gaps are all within ${SEAM_GAP_MM} mm, so the parts were most likely never joined while modelling ` +
      '(one Tinkercad grid-snap step off is exactly 1 mm). ' +
      'If so, simply enabling support is the wrong fix: the support fills the gap, and once it is removed the two pieces come apart. ' +
      'The real fix is to go back to the modelling software, move or stretch the part so the two overlap by at least 0.5 mm, ' +
      'then merge them (Group in Tinkercad). ' +
      `${SEAM_GAP_MM} mm is only a rule of thumb, not a verdict: if this is an intentional moving clearance ` +
      '(a print-in-place ball in a cage, a joint), do not close the gap; that piece still needs support, ' +
      'or a design change so it rests on the plate. Confirm the design intent first.'
    : 'The pieces with wide gaps are hanging in mid-air and need support, or a different orientation, so they have something to stand on.' +
      (seams.length > 0
        ? ` Another ${seams.length} piece(s) have gaps within ${SEAM_GAP_MM} mm and were most likely never joined while modelling ` +
          '(fix that in the modelling software rather than enabling support), unless it is an intentional moving clearance.'
        : '');

  return {
    code: 'floating-part',
    severity: 'blocker',
    summary:
      `${floating.length} solid(s) do not reach the plate` +
      (Number.isFinite(narrowest) ? ` (narrowest gap ${narrowest.toFixed(3)} mm)` : ''),
    detail:
      `${lines.join('; ')}. ${advice}` +
      ' Bambu Studio reports this as "Levitating objects cannot be printed without supports" or "floating regions".' +
      ' Gap widths are in the model\'s original dimensions and scale proportionally if the model is scaled in Studio.',
    relatedParameters: allSeams ? [] : ['enable_support', 'support_type'],
  };
}

function severityRank(severity: PrintabilityFinding['severity']): number {
  switch (severity) {
    case 'blocker':
      return 0;
    case 'warning':
      return 1;
    case 'note':
      return 2;
  }
}

type OverhangMeasurement = { readonly ratio: number; readonly maxDegrees: number };

/**
 * Compute the fraction of surface area that faces downward and is steeper than the threshold.
 *
 * For a unit normal n, a downward face has n.z < 0 and its angle from vertical is asin(-n.z):
 * n.z = 0 (vertical wall) gives 0°, n.z = -1 (horizontal ceiling) gives 90°.
 *
 * The bottom face resting on the heated bed is also a "downward horizontal face", but it lies
 * directly on the plate and needs no support, so triangles lying entirely within the lowest
 * layer are excluded. Without this check a plain cube would be reported as needing support on
 * one sixth of its surface area, which is wrong.
 */
const BED_CONTACT_EPSILON = 1e-3;

function measureOverhang(
  triangles: readonly Triangle[],
  thresholdDegrees: number,
  minZ: number,
): OverhangMeasurement {
  let overhangArea = 0;
  let totalArea = 0;
  let maxDegrees = 0;

  for (const triangle of triangles) {
    const normal = faceNormal(triangle);
    if (normal === undefined) continue;
    const area = triangleArea(triangle);
    totalArea += area;

    if (normal.z >= 0) continue;

    const restsOnBed =
      Math.max(triangle.a.z, triangle.b.z, triangle.c.z) <= minZ + BED_CONTACT_EPSILON;
    if (restsOnBed) continue;

    const degrees = (Math.asin(Math.min(1, -normal.z)) * 180) / Math.PI;
    if (degrees > maxDegrees) maxDegrees = degrees;
    if (degrees > thresholdDegrees) overhangArea += area;
  }

  return {
    ratio: totalArea <= 0 ? 0 : overhangArea / totalArea,
    maxDegrees,
  };
}

/**
 * Estimate the area in contact with the heated bed: downward-facing triangles within one
 * layer height above the lowest point.
 *
 * This is a projection approximation, not an exact first-layer cross-section; it is good
 * enough for order-of-magnitude questions like "is the contact area large enough", but must
 * not be used as the exact first-layer area.
 */
function measureFootprintArea(
  triangles: readonly Triangle[],
  box: ReturnType<typeof boundingBox>,
): number {
  const threshold = box.min.z + 0.25;
  let area = 0;

  for (const triangle of triangles) {
    const maxZ = Math.max(triangle.a.z, triangle.b.z, triangle.c.z);
    if (maxZ > threshold) continue;
    const normal = faceNormal(triangle);
    if (normal === undefined || normal.z >= -0.5) continue;
    // Project onto the XY plane.
    area += triangleArea(triangle) * Math.abs(normal.z);
  }

  return area;
}

function fmt(v: Vec3): string {
  return `${v.x.toFixed(1)}×${v.y.toFixed(1)}×${v.z.toFixed(1)}`;
}
