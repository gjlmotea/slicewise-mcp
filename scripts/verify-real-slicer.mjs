import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { defaultDataDir } from '../dist/adapters/node-preset-store.js';
import { defaultExecutablePath } from '../dist/adapters/bambu-studio-cli.js';

/**
 * End-to-end verification against a real Bambu Studio installation.
 *
 * Difference from `stdio-smoke.mjs`: the smoke test uses fixtures and runs on any machine; this one
 * needs Bambu Studio actually installed locally, launches the slicer and produces 3MF files. It is
 * therefore **not part of `pnpm verify`** and is run by hand on a machine that has it installed.
 *
 * It proves six things:
 *   1. After the preset inheritance chain is flattened, slicing uses the system preset's real values,
 *      not the executable's built-in defaults
 *   2. When the printer model has a G-code template, the output's start G-code is that template,
 *      not the generic start section from fdm_machine_common
 *   3. Parameter overrides actually reach the output (rather than being silently ignored)
 *   4. The override audit honestly reports overrides that were not honoured
 *   5. negative_part really changes the geometry (criterion: max_z_height)
 *   6. modifier_part settings apply only to the region it covers
 *      (criterion: left/right split of infill path length within one layer)
 *
 * Usage:
 *   node scripts/verify-real-slicer.mjs
 *   node scripts/verify-real-slicer.mjs --machine "Bambu Lab X1 Carbon 0.4 nozzle" \
 *     --process "0.20mm Standard @BBL X1C" --filament "Bambu PLA Basic @BBL X1C"
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dataDir = arg('data-dir', defaultDataDir());
const slicerPath = arg('slicer', defaultExecutablePath());

if (!existsSync(slicerPath)) {
  console.error(`Bambu Studio executable not found: ${slicerPath}`);
  console.error('This script needs a real Bambu Studio installation. Pass the path with --slicer, or run pnpm smoke instead.');
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), 'bambu-mcp-e2e-'));
const outDir = join(workDir, 'out');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(workDir, 'cube.stl'), buildCubeStl(20));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: projectRoot,
  stderr: 'ignore',
  env: {
    ...getDefaultEnvironment(),
    BAMBU_DATA_DIR: dataDir,
    BAMBU_STUDIO_PATH: slicerPath,
    BAMBU_OUTPUT_DIR: outDir,
    BAMBU_MODEL_DIR: workDir,
    BAMBU_SLICE_TIMEOUT_MS: '180000',
  },
});
const client = new Client({ name: 'bambu-real-slicer-verify', version: '1.0.0' });
const call = async (name, args) =>
  (await client.callTool({ name, arguments: args })).structuredContent;

try {
  await client.connect(transport);

  const status = await call('bambu_get_status', {});
  assert.equal(status.slicerAvailable, true, 'the slicer should be available');
  console.log(`Data directory ${status.dataDir}`);
  console.log(
    `Selectable presets: machine ${status.presetCounts.machine} / process ${status.presetCounts.process} / filament ${status.presetCounts.filament}`,
  );

  const machine = arg('machine', status.currentSelection.machine);
  const process_ = arg('process', status.currentSelection.process);
  const filament = arg('filament', status.currentSelection.filaments?.[0]);
  assert.ok(machine && process_ && filament, 'no usable preset combination found; specify one with --machine/--process/--filament');
  console.log(`Using ${machine} / ${process_} / ${filament}\n`);

  // ── 1. Flatten ────────────────────────────────────────────────────────
  const resolved = await call('bambu_resolve_preset', { name: process_, kind: 'process' });
  console.log(`Inheritance chain: ${resolved.inheritanceChain.join('  <-  ')}`);
  console.log(`${resolved.settingCount} settings after flattening\n`);
  assert.ok(resolved.inheritanceChain.length > 1, 'a system process preset should have an inheritance chain');

  // These parameters are all inherited from parents and not declared by the leaf preset itself; exactly the kind the CLI loses.
  const INHERITED_KEYS = [
    'sparse_infill_density',
    'top_shell_layers',
    'elefant_foot_compensation',
    'brim_width',
  ];

  // ── 2. Baseline slice, reading back the values actually applied ──────
  const baseline = await call('bambu_slice', {
    modelPath: join(workDir, 'cube.stl'),
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
    reportSettings: [...INHERITED_KEYS, 'machine_start_gcode'],
  });
  assert.equal(baseline.ok, true, `baseline slice failed: ${baseline.reason ?? ''}`);
  console.log(
    `Baseline: ${baseline.stats.layerCount} layers, ${baseline.stats.totalEstimatedTimeSeconds}s, ${baseline.stats.filamentGrams} g\n`,
  );

  // ── Core assertion ───────────────────────────────────────────────────
  // The values the output actually uses must equal the flattened system preset values.
  // If the raw preset were fed straight to the CLI (which is what every existing tool does), these
  // inherited parameters would all fall back to the BambuStudio executable's built-in defaults;
  // that is BambuStudio#1704.
  console.log('Inherited parameters: flattened preset value vs actual output value:');
  for (const key of INHERITED_KEYS) {
    const expected = resolved.settings[key];
    const actual = baseline.appliedSettings[key];
    const same = normalise(expected) === normalise(actual);
    console.log(`  ${same ? '✓' : '✗'} ${key}: preset ${JSON.stringify(expected)} → output ${JSON.stringify(actual)}`);
    assert.ok(
      same,
      `${key} did not keep the system preset value (preset ${JSON.stringify(expected)}, output ${JSON.stringify(actual)}). ` +
        'This means inheritance flattening is broken.',
    );
  }

  // Since BambuStudio 02.07, printer-model G-code lives in "<preset> template <key>" entries, not in the leaf preset.
  // If the template is not applied, the output gets the generic start section from fdm_machine_common (G28 / G29 / M109 S205).
  const machineGcode = await call('bambu_resolve_preset', {
    name: machine,
    kind: 'machine',
    keys: ['machine_start_gcode'],
  });
  const startSource = machineGcode.provenance.machine_start_gcode;
  console.log(`\nStart G-code source: ${startSource}`);
  if (startSource?.includes(' template ')) {
    assert.equal(
      baseline.appliedSettings.machine_start_gcode,
      machineGcode.settings.machine_start_gcode,
      'the output start G-code must be the system template; a mismatch means the template was not applied and the generic start section was used.',
    );
    console.log('  ✓ output start G-code is identical to the system template');
  } else {
    console.log('  (this printer model has no G-code template; skipped)');
  }

  // ── 3. Overrides + audit ──────────────────────────────────────────────
  const tuned = await call('bambu_slice', {
    modelPath: join(workDir, 'cube.stl'),
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
    overrides: {
      layer_height: '0.28',
      sparse_infill_density: '10%',
      wall_loops: '4',
      layer_hieght: '0.3', // deliberately misspelled, to verify it gets caught
    },
  });
  if (tuned.ok !== true) {
    console.error(`\nOverride slice failed: ${tuned.reason}`);
    for (const line of tuned.stderrTail ?? []) console.error(`  ${line}`);
  }
  assert.equal(tuned.ok, true, `override slice failed: ${tuned.reason ?? ''}`);
  console.log(
    `\nWith overrides: ${tuned.stats.layerCount} layers, ${tuned.stats.totalEstimatedTimeSeconds}s, layer height ${tuned.stats.layerHeight}`,
  );

  console.log('\nOverride audit:');
  for (const entry of tuned.overrideAudit) {
    console.log(
      `  ${entry.honoured ? '✓' : '✗'} ${entry.key}: requested ${JSON.stringify(entry.requested)} → output ${JSON.stringify(entry.applied)}`,
    );
  }

  const byKey = Object.fromEntries(tuned.overrideAudit.map((entry) => [entry.key, entry]));
  assert.equal(byKey['layer_height'].honoured, true, 'the layer_height override must be honoured');
  assert.equal(byKey['sparse_infill_density'].honoured, true, 'the sparse_infill_density override must be honoured');
  assert.equal(byKey['wall_loops'].honoured, true, 'the wall_loops override must be honoured');
  assert.equal(byKey['layer_hieght'].honoured, false, 'a misspelled key must be marked as not honoured');

  // Layer height goes from 0.2 to 0.28, so the layer count must actually drop.
  assert.ok(
    tuned.stats.layerCount < baseline.stats.layerCount,
    `layer count should drop after raising the layer height: ${baseline.stats.layerCount} -> ${tuned.stats.layerCount}`,
  );
  assert.equal(tuned.stats.layerHeight, 0.28, 'the layer height in the G-code header must equal the requested value');

  console.log('\nWarnings:');
  for (const warning of tuned.warnings) console.log(`  · ${warning}`);

  // ── 4. Non-destructive parts (negative_part) ──────────────────────────
  //
  // This section verifies that Bambu's non-destructive editing needs neither a geometry kernel
  // nor GUI automation: it is simply "one more part plus a subtype tag".
  //
  // The criterion is deliberately max_z_height: an honoured negative part trims the 20 mm cube to 15 mm.
  // If the subtype were ignored and treated as normal_part, the height would become 25 mm. Both failure modes are caught.
  console.log('\n── Non-destructive parts ──');

  const composed = await call('bambu_compose_model', {
    name: 'e2e-topcut',
    basePath: join(workDir, 'cube.stl'),
    baseName: 'cube',
    parts: [
      {
        name: 'topcut',
        subtype: 'negative_part',
        shape: { kind: 'box', size: { x: 40, y: 40, z: 10 } },
        position: { x: 10, y: 10, z: 20 }, // the cube spans 0–20; this block covers 15–25
      },
    ],
  });
  assert.ok(composed.outputPath, `compose failed: ${JSON.stringify(composed)}`);
  console.log(`Composed ${composed.outputPath} (${composed.byteLength} bytes)`);
  for (const part of composed.parts) {
    console.log(`  ${part.subtype.padEnd(15)} ${part.name} — ${part.triangleCount} faces, intersects body: ${part.intersectsBody}`);
  }
  assert.equal(composed.parts[1].intersectsBody, true, 'the negative part must intersect the body to have any effect');

  // Read the file back to confirm the tag really was written; this is the key advantage of the file route over the GUI.
  const structure = await call('bambu_inspect_project', { projectPath: composed.outputPath });
  const parts = structure.objects[0].parts;
  console.log(`Read back: ${parts.map((p) => `${p.name}=${p.subtype}`).join(', ')}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].subtype, 'normal_part');
  assert.equal(parts[1].subtype, 'negative_part');
  assert.ok(parts.every((p) => p.recognised), 'every subtype must be one BambuStudio recognises');

  const cut = await call('bambu_slice', {
    modelPath: composed.outputPath,
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
  });
  assert.equal(cut.ok, true, `negative-part slice failed: ${cut.reason ?? ''}`);

  console.log(`\nBaseline cube: max_z ${baseline.stats.maxZHeight} mm, ${baseline.stats.layerCount} layers, ${baseline.stats.filamentGrams} g`);
  console.log(`Top cut away: max_z ${cut.stats.maxZHeight} mm, ${cut.stats.layerCount} layers, ${cut.stats.filamentGrams} g`);

  // The printed height is not exactly the model height: when the layer height does not divide evenly,
  // the last layer overshoots slightly (0.16 layer height, 0.2 first layer -> 0.2 + 124×0.16 = 20.04).
  // So a tolerance of one layer is allowed.
  const tolerance = baseline.stats.layerHeight * 1.5;
  assert.ok(
    Math.abs(baseline.stats.maxZHeight - 20) < tolerance,
    `the baseline cube should be about 20 mm tall, got ${baseline.stats.maxZHeight}`,
  );
  assert.ok(
    Math.abs(cut.stats.maxZHeight - 15) < tolerance,
    `negative_part must trim the height to about 15 mm, got ${cut.stats.maxZHeight}`,
  );
  assert.ok(cut.stats.filamentGrams < baseline.stats.filamentGrams, 'filament usage should drop after cutting a piece away');

  // ── 5. Local settings region (modifier_part) ──────────────────────────
  //
  // A negative part changes geometry; a modifier changes "slice that region with different settings".
  // The latter cannot be seen from the outer shape, so the criterion is spatial: within one layer, the half
  // covered by the modifier must have clearly more infill path length than the other half.
  // Total filament alone is not enough; it cannot rule out "the settings were applied to the whole object".
  console.log('\n── Local settings region ──');

  const modified = await call('bambu_compose_model', {
    name: 'e2e-modifier',
    basePath: join(workDir, 'cube.stl'),
    baseName: 'cube',
    parts: [
      {
        name: 'dense-half',
        subtype: 'modifier_part',
        // The cube spans 0–20; this block only covers the x 0–10 half.
        shape: { kind: 'box', size: { x: 10, y: 24, z: 24 } },
        position: { x: 5, y: 10, z: 10 },
        settings: { sparse_infill_density: '90%' },
      },
    ],
  });
  assert.ok(modified.outputPath, `modifier compose failed: ${JSON.stringify(modified)}`);

  const modifierStructure = await call('bambu_inspect_project', { projectPath: modified.outputPath });
  const modifierPart = modifierStructure.objects[0].parts[1];
  console.log(`Read back: ${modifierPart.name}=${modifierPart.subtype}, settings ${JSON.stringify(modifierPart.settings)}`);
  assert.equal(modifierPart.subtype, 'modifier_part');
  assert.equal(modifierPart.settings.sparse_infill_density, '90%', 'part-level settings must be written into the 3MF');

  const modifiedSlice = await call('bambu_slice', {
    modelPath: modified.outputPath,
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
  });
  assert.equal(modifiedSlice.ok, true, `modifier slice failed: ${modifiedSlice.reason ?? ''}`);

  const split = measureInfillSplit(readGcodeFromProduct(modifiedSlice.outputPath), 10);
  console.log(
    `Infill path length: modifier side ${split.dense.toFixed(0)} mm, other side ${split.sparse.toFixed(0)} mm` +
      ` (ratio ${(split.dense / split.sparse).toFixed(2)})`,
  );
  console.log(
    `Filament: baseline ${baseline.stats.filamentGrams} g → locally densified ${modifiedSlice.stats.filamentGrams} g`,
  );

  assert.ok(
    split.dense / split.sparse > 1.8,
    `infill on the modifier side should be clearly denser, but the ratio is only ${(split.dense / split.sparse).toFixed(2)}`,
  );
  assert.ok(
    modifiedSlice.stats.filamentGrams > baseline.stats.filamentGrams,
    'filament usage should increase after local densification',
  );

  console.log('\nEnd-to-end verification against the real slicer passed.');
} finally {
  await client.close();
  rmSync(workDir, { recursive: true, force: true });
}

/** Normalises before comparison: `"15%"` and `"15"`, `"0.28"` and `"0.280000"` mean the same thing. */
function normalise(value) {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join(',') : String(value);
  const trimmed = text.trim().replace(/%$/, '');
  return /^-?\d*\.?\d+$/.test(trimmed) ? String(Number.parseFloat(trimmed)) : trimmed;
}

/** Extracts the first plate's G-code from a .gcode.3mf output. */
function readGcodeFromProduct(path) {
  const buffer = readFileSync(path);
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
 * Measures how the infill path length within one layer splits between the left and right halves.
 *
 * Used to verify that a modifier really applies only to the region it covers. The split point is the
 * midpoint of the x range of that layer's infill segments, so there is no need to know where the
 * model sits on the plate.
 *
 * Only extrusion moves under `; FEATURE: Sparse infill` are counted; walls and solid layers are the
 * same on both sides and would dilute the difference.
 */
function measureInfillSplit(gcode, targetZ) {
  const layers = new Map();
  let z = 0;
  let x = 0;
  let y = 0;
  let feature = '';

  for (const line of gcode.split('\n')) {
    if (line.startsWith('; FEATURE:')) {
      feature = line.slice(10).trim();
      continue;
    }
    if (!/^G[0123]\s/.test(line)) continue;

    const zMove = /\sZ(-?[\d.]+)/.exec(line);
    if (zMove) z = Number.parseFloat(zMove[1]);

    const nx = /\sX(-?[\d.]+)/.exec(line);
    const ny = /\sY(-?[\d.]+)/.exec(line);
    const e = /\sE(-?[\d.]+)/.exec(line);
    const toX = nx ? Number.parseFloat(nx[1]) : x;
    const toY = ny ? Number.parseFloat(ny[1]) : y;

    if (feature === 'Sparse infill' && e && Number.parseFloat(e[1]) > 0 && (nx || ny)) {
      const key = z.toFixed(2);
      if (!layers.has(key)) layers.set(key, []);
      layers.get(key).push({
        length: Math.hypot(toX - x, toY - y),
        midX: (x + toX) / 2,
      });
    }
    x = toX;
    y = toY;
  }

  let best = null;
  for (const [key, segments] of layers) {
    const layerZ = Number.parseFloat(key);
    if (segments.length < 20) continue;
    if (best === null || Math.abs(layerZ - targetZ) < Math.abs(best.z - targetZ)) {
      best = { z: layerZ, segments };
    }
  }
  assert.ok(best !== null, 'no layer with enough infill paths found');

  const xs = best.segments.map((s) => s.midX).sort((a, b) => a - b);
  const splitAt = (xs[0] + xs[xs.length - 1]) / 2;

  let dense = 0;
  let sparse = 0;
  for (const segment of best.segments) {
    if (segment.midX < splitAt) dense += segment.length;
    else sparse += segment.length;
  }
  return { dense, sparse, z: best.z };
}

function buildCubeStl(size) {
  const v = [
    [0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0],
    [0, 0, size], [size, 0, size], [size, size, size], [0, size, size],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buffer = Buffer.alloc(84 + faces.length * 50);
  buffer.write('bambu-mcp e2e cube', 0, 'ascii');
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
