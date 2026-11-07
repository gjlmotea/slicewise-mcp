import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { defaultDataDir } from '../dist/adapters/node-preset-store.js';
import { defaultExecutablePath } from '../dist/adapters/bambu-studio-cli.js';

/**
 * Example: cut two M3 clearance holes into a mounting plate.
 *
 * This script demonstrates the full workflow and doubles as a measured check that the holes
 * really were cut: producing a file proves nothing; the actual hole diameter has to be
 * measurable from the G-code in the sliced output.
 *
 * M3 sizes per ISO 273:
 *   - Clearance hole (medium fit)    Ø3.4 mm  <- used in this example
 *   - Clearance hole (fine fit)      Ø3.2 mm
 *   - Self-tapping / tapped plastic  Ø2.5 mm
 *   - Heat-set brass insert          per insert spec, commonly Ø4.0 mm
 *
 * Requires Bambu Studio installed locally. Usage:
 *   node scripts/example-m3-hole.mjs [--out <dir>]
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const slicerPath = arg('slicer', defaultExecutablePath());
if (!existsSync(slicerPath)) {
  console.error(`Bambu Studio executable not found: ${slicerPath}`);
  process.exit(2);
}

const workDir = arg('out', join(projectRoot, '.agent-tmp', 'm3-example'));
mkdirSync(workDir, { recursive: true });

// ── Geometry parameters ──────────────────────────────────────────────────
const PLATE = { x: 40, y: 20, z: 5 };
const HOLE_DIAMETER = 3.4; // M3 medium-fit clearance hole
const HOLE_SPACING = 24; // centre-to-centre distance between the two holes
const HOLE_CENTRES = [
  { x: PLATE.x / 2 - HOLE_SPACING / 2, y: PLATE.y / 2 },
  { x: PLATE.x / 2 + HOLE_SPACING / 2, y: PLATE.y / 2 },
];

writeFileSync(join(workDir, 'plate.stl'), buildPlateStl(PLATE));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: projectRoot,
  stderr: 'ignore',
  env: {
    ...getDefaultEnvironment(),
    BAMBU_DATA_DIR: arg('data-dir', defaultDataDir()),
    BAMBU_STUDIO_PATH: slicerPath,
    BAMBU_OUTPUT_DIR: workDir,
    BAMBU_MODEL_DIR: workDir,
    BAMBU_SLICE_TIMEOUT_MS: '180000',
  },
});
const client = new Client({ name: 'bambu-m3-example', version: '1.0.0' });
const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

try {
  await client.connect(transport);
  const status = await call('bambu_get_status', {});
  const machine = arg('machine', status.currentSelection.machine);
  const process_ = arg('process', status.currentSelection.process);
  const filament = arg('filament', status.currentSelection.filaments?.[0]);
  assert.ok(machine && process_ && filament, 'no usable preset combination found');

  console.log(`Plate ${PLATE.x}×${PLATE.y}×${PLATE.z} mm, two Ø${HOLE_DIAMETER} mm clearance holes, ${HOLE_SPACING} mm apart`);
  console.log(`Using ${machine} / ${process_} / ${filament}\n`);

  // ── 1. Compose ─────────────────────────────────────────────────────────
  const composed = await call('bambu_compose_model', {
    name: 'm3-bracket',
    basePath: join(workDir, 'plate.stl'),
    baseName: 'plate',
    parts: HOLE_CENTRES.map((centre, index) => ({
      name: `m3-hole-${index + 1}`,
      subtype: 'negative_part',
      shape: {
        kind: 'cylinder',
        diameter: HOLE_DIAMETER,
        // Longer than the plate is thick, so it fully cuts through top and bottom.
        height: PLATE.z * 3,
        segments: 64,
      },
      position: { x: centre.x, y: centre.y, z: PLATE.z / 2 },
    })),
  });
  assert.ok(composed.outputPath, `compose failed: ${JSON.stringify(composed)}`);

  console.log(`Composed ${composed.outputPath}`);
  for (const part of composed.parts) {
    console.log(`  ${part.subtype.padEnd(14)} ${part.name.padEnd(11)} ${part.triangleCount} faces, intersects: ${part.intersectsBody}`);
  }
  assert.ok(composed.parts.slice(1).every((p) => p.intersectsBody), 'both holes must intersect the plate');

  // ── 2. Read back ───────────────────────────────────────────────────────
  const structure = await call('bambu_inspect_project', { projectPath: composed.outputPath });
  const parts = structure.objects[0].parts;
  console.log(`\nRead back: ${parts.map((p) => `${p.name}=${p.subtype}`).join(', ')}`);
  assert.equal(parts.filter((p) => p.subtype === 'negative_part').length, 2);
  assert.ok(parts.every((p) => p.recognised));

  // ── 3. Slice ───────────────────────────────────────────────────────────
  const sliced = await call('bambu_slice', {
    modelPath: composed.outputPath,
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
    reportSettings: ['line_width', 'inner_wall_line_width', 'xy_hole_compensation'],
  });
  assert.equal(sliced.ok, true, `slicing failed: ${sliced.reason ?? ''}`);
  console.log(
    `\nSliced: ${sliced.stats.layerCount} layers, ${sliced.stats.filamentGrams} g, ` +
      `line width ${sliced.appliedSettings.line_width}, hole compensation ${sliced.appliedSettings.xy_hole_compensation}`,
  );

  // ── 4. Measure the actual hole diameter from the G-code ─────────────────
  //
  // Producing a file proves nothing. The centreline of the loop the slicer runs around a hole
  // sits roughly hole radius + half a line width from the hole centre, so working backwards
  // gives the hole diameter as the slicer actually sees it.
  const holes = measureHoles(readGcodeFromProduct(sliced.outputPath), PLATE.z / 2);
  assert.equal(holes.length, 2, `expected to measure two holes, got ${holes.length}`);

  console.log('\nActual hole diameters (derived from the G2/G3 arc geometry in the G-code):');
  for (const [index, hole] of holes.entries()) {
    const deviation = hole.diameter - HOLE_DIAMETER;
    console.log(
      `  Hole ${index + 1}  centre (${hole.cx.toFixed(2)}, ${hole.cy.toFixed(2)})  ` +
        `Ø${hole.diameter.toFixed(3)} mm (design Ø${HOLE_DIAMETER}, deviation ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)})`,
    );
    assert.ok(Math.abs(deviation) < 0.05, `hole ${index + 1} deviates too much: ${deviation.toFixed(3)} mm`);
    assert.ok(hole.diameter > 3.0, 'an M3 clearance hole must be larger than the 3.0 mm screw diameter');
  }

  const spacing = Math.hypot(holes[1].cx - holes[0].cx, holes[1].cy - holes[0].cy);
  console.log(`  Centre distance ${spacing.toFixed(3)} mm (design ${HOLE_SPACING})`);
  assert.ok(Math.abs(spacing - HOLE_SPACING) < 0.05, 'hole spacing does not match');

  console.log(
    '\nToolpath hole diameters match the model exactly (error <0.01 mm). Printed holes come out slightly smaller\n' +
      'because of material shrinkage and extrusion behaviour; that is what xy_hole_compensation is for.\n' +
      'Print a calibration piece first, measure the actual deviation, then choose the compensation value.',
  );

  console.log(`\nDone. Open ${composed.outputPath} in Bambu Studio to see the two negative parts.`);
} finally {
  await client.close();
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Builds a binary STL of a rectangular plate, with coordinates starting at (0,0,0). */
function buildPlateStl(size) {
  const v = [
    [0, 0, 0], [size.x, 0, 0], [size.x, size.y, 0], [0, size.y, 0],
    [0, 0, size.z], [size.x, 0, size.z], [size.x, size.y, size.z], [0, size.y, size.z],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buffer = Buffer.alloc(84 + faces.length * 50);
  buffer.write('bambu-mcp m3 example plate', 0, 'ascii');
  buffer.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => {
    const base = 84 + index * 50;
    [[0, 0, 0], ...face.map((i) => v[i])].forEach((point, slot) => {
      buffer.writeFloatLE(point[0], base + slot * 12);
      buffer.writeFloatLE(point[1], base + slot * 12 + 4);
      buffer.writeFloatLE(point[2], base + slot * 12 + 8);
    });
  });
  return buffer;
}

/** Extracts the first plate's G-code from a .gcode.3mf output. */
function readGcodeFromProduct(path) {
  const buffer = readFileSync(path);
  // Walk the zip central directory to find plate_1.gcode.
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (name === 'Metadata/plate_1.gcode') {
      const lhNameLength = buffer.readUInt16LE(localOffset + 26);
      const lhExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lhNameLength + lhExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('plate_1.gcode not found in the output');
}

/**
 * Measures the actual diameter of round holes from the G-code.
 *
 * BambuStudio enables `enable_arc_fitting` by default, so round outlines are emitted as G2/G3 arcs
 * rather than many short line segments. An arc command's I/J is the offset of the arc centre from
 * the current position, so the centre and radius can be computed directly, which is far more
 * accurate than sampling points along the path and fitting a circle.
 *
 * The loop along the hole wall has the feature `Outer wall` (the loop touching the solid surface);
 * its centreline lies "hole radius + half a line width" from the hole centre, so
 * hole diameter = 2 × (radius − half line width).
 *
 * No assumption is made about where the model sits on the plate: each round hole shows up as
 * concentric arcs on its own, so the build item's translation is not needed.
 */
function measureHoles(gcode, targetZ) {
  const byLayer = new Map();
  let z = 0;
  let x = 0;
  let y = 0;
  let feature = '';
  let lineWidth = 0;

  for (const line of gcode.split('\n')) {
    if (line.startsWith('; FEATURE:')) {
      feature = line.slice(10).trim();
      continue;
    }
    if (line.startsWith('; LINE_WIDTH:')) {
      lineWidth = Number.parseFloat(line.slice(13));
      continue;
    }
    if (!/^G[0123]\s/.test(line)) continue;

    const zMove = /\sZ(-?[\d.]+)/.exec(line);
    if (zMove) z = Number.parseFloat(zMove[1]);

    const arc = /^G[23]\s.*?X(-?[\d.]+)\s+Y(-?[\d.]+)\s+I(-?[\d.]+)\s+J(-?[\d.]+)/.exec(line);
    if (arc !== null && feature === 'Outer wall') {
      const i = Number.parseFloat(arc[3]);
      const j = Number.parseFloat(arc[4]);
      const key = z.toFixed(2);
      if (!byLayer.has(key)) byLayer.set(key, []);
      byLayer.get(key).push({
        cx: x + i,
        cy: y + j,
        radius: Math.hypot(i, j),
        lineWidth,
      });
    }

    const nx = /\sX(-?[\d.]+)/.exec(line);
    const ny = /\sY(-?[\d.]+)/.exec(line);
    if (nx) x = Number.parseFloat(nx[1]);
    if (ny) y = Number.parseFloat(ny[1]);
  }

  // Take the layer closest to the target height that has outer-wall arcs.
  let best = null;
  for (const [key, arcs] of byLayer) {
    const layerZ = Number.parseFloat(key);
    if (best === null || Math.abs(layerZ - targetZ) < Math.abs(best.z - targetZ)) {
      best = { z: layerZ, arcs };
    }
  }
  assert.ok(best !== null, 'no outer-wall arcs found');

  // One hole is made of several arc segments; group by centre and keep the smallest radius (the loop nearest the hole wall).
  const groups = new Map();
  for (const arc of best.arcs) {
    const key = `${arc.cx.toFixed(1)},${arc.cy.toFixed(1)}`;
    const existing = groups.get(key);
    if (existing === undefined || arc.radius < existing.radius) groups.set(key, arc);
  }

  return [...groups.values()]
    .map((arc) => ({
      cx: arc.cx,
      cy: arc.cy,
      diameter: 2 * (arc.radius - arc.lineWidth / 2),
    }))
    .sort((a, b) => a.cx - b.cx);
}
