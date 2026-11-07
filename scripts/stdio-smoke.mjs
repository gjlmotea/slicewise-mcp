import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * stdio smoke test.
 *
 * Uses a fixture data directory instead of the user's local BambuStudio, so it runs on
 * machines without Bambu Studio installed (including CI) and the result is deterministic.
 * Real slicing needs the actual executable and is out of scope for the smoke test;
 * end-to-end slicing verification is scripts/verify-real-slicer.mjs (see "Development" in the README).
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureDataDir = join(projectRoot, 'tests/fixtures/datadir');

const workDir = await mkdtemp(join(tmpdir(), 'bambu-mcp-smoke-'));
const dataDir = join(workDir, 'datadir');
const modelDir = join(workDir, 'models');

// Copy the fixtures before use so the smoke test never dirties the version-controlled ones.
await cp(fixtureDataDir, dataDir, { recursive: true });
await cp(join(projectRoot, 'tests/fixtures/models'), modelDir, { recursive: true }).catch(() => {});
await writeFile(join(modelDir, 'cube.stl'), buildCubeStl(20), { flag: 'w' }).catch(async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, 'cube.stl'), buildCubeStl(20));
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    BAMBU_DATA_DIR: dataDir,
    BAMBU_MODEL_DIR: modelDir,
    BAMBU_OUTPUT_DIR: join(workDir, 'out'),
    BAMBU_STUDIO_PATH: join(workDir, 'no-such-slicer'),
  },
});
const client = new Client({ name: 'bambu-stdio-smoke', version: '1.0.0' });

try {
  await client.connect(transport);

  // ── Tool surface ─────────────────────────────────────────────────────
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'bambu_check_printability',
      'bambu_compare_presets',
      'bambu_compose_model',
      'bambu_describe_parameters',
      'bambu_diagnose',
      'bambu_get_status',
      'bambu_inspect_model',
      'bambu_inspect_project',
      'bambu_list_presets',
      'bambu_measure_clearance',
      'bambu_optimize_print_in_place',
      'bambu_plan_settings',
      'bambu_resolve_preset',
      'bambu_save_user_preset',
      'bambu_search_models',
      'bambu_slice',
    ],
  );

  // ── Status ───────────────────────────────────────────────────────────
  const status = await call('bambu_get_status', {});
  assert.equal(status.structuredContent.inheritanceFlattening, true);
  assert.equal(status.structuredContent.presetCounts.process, 1, 'there is only 1 selectable process preset');
  assert.equal(status.structuredContent.currentSelection.machine, 'Bambu Lab P1S 0.4 nozzle');
  assert.equal(status.structuredContent.slicerAvailable, false, 'the smoke test deliberately points at a slicer that does not exist');

  // ── Preset flattening (the core of this server) ─────────────────────
  const resolved = await call('bambu_resolve_preset', {
    name: '0.20mm Standard @BBL P1S',
    kind: 'process',
  });
  const settings = resolved.structuredContent.settings;

  // The leaf preset only declares outer_wall_speed; everything below is only reachable by flattening the inheritance chain.
  assert.equal(settings.sparse_infill_density, '15%', 'inherited from fdm_process_common');
  assert.equal(settings.elefant_foot_compensation, '0.15');
  assert.equal(settings.brim_width, '5');
  // A nearer layer must override a farther one.
  assert.equal(settings.wall_loops, '3', 'fdm_process_bbl_0.20 should override fdm_process_common');
  // Metadata must not leak into the slicing settings.
  assert.equal(settings.description, undefined);
  assert.equal(settings.setting_id, undefined);
  assert.deepEqual(resolved.structuredContent.inheritanceChain, [
    '0.20mm Standard @BBL P1S',
    'fdm_process_bbl_0.20',
    'fdm_process_common',
  ]);
  assert.equal(resolved.structuredContent.provenance.wall_loops, 'fdm_process_bbl_0.20');

  // ── Preset list ─────────────────────────────────────────────────────
  const presets = await call('bambu_list_presets', { kind: 'process' });
  assert.equal(presets.structuredContent.entries.length, 1, 'intermediate presets should be filtered out');
  const withAbstract = await call('bambu_list_presets', { kind: 'process', includeAbstract: true });
  assert.equal(withAbstract.structuredContent.entries.length, 3);

  // ── Parameter knowledge ──────────────────────────────────────────────
  const described = await call('bambu_describe_parameters', { keys: ['layer_height', 'not_a_real_key'] });
  assert.equal(described.structuredContent.specs.length, 1);
  assert.deepEqual(described.structuredContent.unknown, ['not_a_real_key']);

  // The free-text inputs below are deliberately Chinese: they exercise the Chinese symptom and goal aliases.
  const diagnosis = await call('bambu_diagnose', { symptom: '底部一圈胖出來', material: 'PLA' });
  assert.equal(diagnosis.structuredContent.matched[0].id, 'elephant-foot');
  assert.ok(diagnosis.structuredContent.matched[0].remedies.length > 0);
  // Every recommendation must state its cost.
  for (const remedy of diagnosis.structuredContent.matched[0].remedies) {
    assert.ok(remedy.cost.length > 0, `${remedy.key} does not state its cost`);
  }

  const noMatch = await call('bambu_diagnose', { symptom: '完全無關的敘述' });
  assert.equal(noMatch.structuredContent.matched.length, 0);
  assert.match(noMatch.structuredContent.note, /Fuzzy guessing is deliberately not done/);

  // ── Goal-driven planning ─────────────────────────────────────────────
  const plan = await call('bambu_plan_settings', { goal: '不要印壞，慢慢印，怕翹起來也怕撞到', material: 'PLA' });
  assert.equal(plan.isError, false);
  assert.equal(plan.structuredContent.goal.id, 'safe');
  const concerns = new Set(plan.structuredContent.moves.map((move) => move.concern));
  assert.ok(concerns.has('adhesion') && concerns.has('collision'), 'should cover both warping and collision');
  // Every move must state its cost; no parameter change is free.
  for (const move of plan.structuredContent.moves) {
    assert.ok(move.cost.length > 0, `${move.key} does not state its cost`);
    assert.ok(['scalar', 'per-extruder', 'unknown'].includes(move.valueShape));
  }
  // Without a model there should be no geometry-triggered moves.
  assert.equal(plan.structuredContent.moves.filter((m) => m.triggeredBy).length, 0);
  assert.equal(plan.structuredContent.printability, undefined);

  // Only with a model are geometry-based moves added.
  const planWithModel = await call('bambu_plan_settings', {
    goalId: 'safe',
    modelPath: join(modelDir, 'cube.stl'),
  });
  assert.equal(planWithModel.isError, false);
  assert.ok(planWithModel.structuredContent.printability !== undefined, 'printability should be returned when a model is given');

  const noGoal = await call('bambu_plan_settings', { goal: '完全無關的敘述' });
  assert.equal(noGoal.structuredContent.goal, undefined);
  assert.match(noGoal.structuredContent.note, /Guessing is deliberately not done/);
  assert.ok(noGoal.structuredContent.available.length >= 5);

  // ── print-in-place auto-optimisation ────────────────────────────────
  // Preset names below are deliberately non-ASCII to exercise Unicode preset names and file names.
  const optimized = await call('bambu_optimize_print_in_place', {
    name: '0.20mm 齒輪自動穩定 @BBL P1S',
  });
  assert.equal(optimized.isError, false);
  assert.equal(optimized.structuredContent.basePreset, '0.20mm Standard @BBL P1S');
  assert.equal(optimized.structuredContent.overrides.initial_layer_speed, '20');
  assert.equal(optimized.structuredContent.overrides.initial_layer_infill_speed, '30');
  assert.equal(optimized.structuredContent.overrides.outer_wall_speed, '60');
  assert.equal(optimized.structuredContent.overrides.reduce_crossing_wall, '1');
  assert.equal(optimized.structuredContent.overrides.top_surface_pattern, 'monotonicline');
  assert.equal(optimized.structuredContent.overrides.ironing_type, 'no ironing');
  assert.equal(optimized.structuredContent.overrides.fuzzy_skin, 'none');
  assert.equal(optimized.structuredContent.overrides.brim_type, 'no_brim', 'Auto Brim must be explicitly turned off by default');
  assert.ok(optimized.structuredContent.manualActions.some((action) => action.includes('Brim Ears')));

  // ── Writing a user preset ───────────────────────────────────────────
  const saved = await call('bambu_save_user_preset', {
    name: 'AI 調校 0.20 省時',
    kind: 'process',
    inherits: '0.20mm Standard @BBL P1S',
    overrides: { sparse_infill_density: '10%', layer_hieght: '0.28' },
  });
  assert.equal(saved.structuredContent.created, true);
  // A misspelled key must be reported, not silently written so the user thinks it took effect.
  assert.ok(
    saved.structuredContent.warnings.some((warning) => warning.includes('layer_hieght')),
    'a misspelled key should produce a warning',
  );

  // Readable immediately after writing, and actually inherits from the system preset.
  const userPreset = await call('bambu_resolve_preset', {
    name: 'AI 調校 0.20 省時',
    kind: 'process',
  });
  assert.equal(userPreset.structuredContent.settings.sparse_infill_density, '10%');
  assert.equal(userPreset.structuredContent.settings.wall_loops, '3', 'the remaining settings are still inherited from the system preset');
  assert.equal(userPreset.structuredContent.origin, 'user');

  // An existing preset with the same name is not overwritten.
  const conflict = await call('bambu_save_user_preset', {
    name: 'AI 調校 0.20 省時',
    kind: 'process',
    inherits: '0.20mm Standard @BBL P1S',
    overrides: { sparse_infill_density: '5%' },
  });
  assert.equal(conflict.isError, true, 'a preset with the same name must not be silently overwritten');

  // ── Models ───────────────────────────────────────────────────────────
  const inspected = await call('bambu_inspect_model', { modelPath: join(modelDir, 'cube.stl') });
  assert.equal(inspected.structuredContent.triangleCount, 12);
  assert.equal(inspected.structuredContent.closed, true);
  assert.ok(Math.abs(inspected.structuredContent.volumeMm3 - 8000) < 0.5);

  const printability = await call('bambu_check_printability', {
    modelPath: join(modelDir, 'cube.stl'),
  });
  assert.equal(printability.structuredContent.fitsBuildVolume, true);
  // The bottom face resting on the bed must not count as an overhang that needs support.
  assert.equal(printability.structuredContent.overhangAreaRatio, 0);

  // Anything outside the allow-list is refused.
  const denied = await call('bambu_inspect_model', { modelPath: '/etc/passwd' });
  assert.equal(denied.isError, true);

  // ── Composing a 3MF ──────────────────────────────────────────────────
  const composed = await call('bambu_compose_model', {
    name: 'smoke-holed',
    basePath: join(modelDir, 'cube.stl'),
    baseName: 'cube',
    parts: [
      {
        name: 'hole',
        subtype: 'negative_part',
        shape: { kind: 'cylinder', diameter: 6, height: 30 },
        position: { x: 10, y: 10, z: 10 },
      },
      {
        name: 'far-away',
        subtype: 'negative_part',
        shape: { kind: 'box', size: { x: 2, y: 2, z: 2 } },
        position: { x: 500, y: 500, z: 500 },
      },
    ],
  });
  assert.equal(composed.isError, false);
  assert.equal(composed.structuredContent.parts.length, 3);
  // A part that does not touch the body produces a valid file that does nothing; that must be reported.
  assert.equal(composed.structuredContent.parts[2].intersectsBody, false);
  assert.ok(
    composed.structuredContent.warnings.some((warning) => warning.includes('far-away')),
    'a non-intersecting part should produce a warning',
  );

  // What was written must be readable back; this is the key advantage of the file route over GUI automation.
  const structure = await call('bambu_inspect_project', {
    projectPath: composed.structuredContent.outputPath,
  });
  assert.equal(structure.isError, false);
  const parts = structure.structuredContent.objects[0].parts;
  assert.deepEqual(
    parts.map((part) => [part.name, part.subtype]),
    [
      ['cube', 'normal_part'],
      ['hole', 'negative_part'],
      ['far-away', 'negative_part'],
    ],
  );
  assert.ok(parts.every((part) => part.recognised), 'every subtype must be one BambuStudio recognises');

  // A misspelled subtype must be rejected: BambuStudio silently treats it as normal_part,
  // so "cut a piece away" turns into "add a solid piece".
  const badSubtype = await call('bambu_compose_model', {
    name: 'smoke-bad',
    basePath: join(modelDir, 'cube.stl'),
    parts: [{ name: 'x', subtype: 'negative-part', shape: { kind: 'box', size: { x: 1, y: 1, z: 1 } } }],
  });
  assert.equal(badSubtype.isError, true);

  // ── Search ───────────────────────────────────────────────────────────
  const search = await call('bambu_search_models', { query: 'benchy', sources: ['makerworld'] });
  const makerworld = search.structuredContent.results[0];
  assert.equal(makerworld.integration, 'handoff-only');
  assert.equal(makerworld.hits.length, 0, 'without an official API there must be no pretend results');
  assert.match(makerworld.handoffUrl, /makerworld\.com/);

  // ── Slicing must fail explicitly without an executable, never pretend to succeed ──
  const slice = await call('bambu_slice', { modelPath: join(modelDir, 'cube.stl') });
  assert.equal(slice.isError, true);
  assert.match(slice.structuredContent.reason, /BambuStudio executable not found|BAMBU_OUTPUT_DIR/);

  process.stdout.write('Bambu MCP stdio smoke passed.\n');
} finally {
  await client.close();
  await rm(workDir, { recursive: true, force: true });
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}

/** Builds a binary STL cube with outward-facing normals. */
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
  buffer.write('bambu-mcp smoke cube', 0, 'ascii');
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
