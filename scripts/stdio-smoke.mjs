import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * stdio smoke。
 *
 * 用 fixture 資料目錄而不是使用者本機的 BambuStudio，這樣沒裝 Bambu Studio 的機器
 * （包括 CI）也能跑，而且結果是決定性的。實際切片需要真的執行檔，不在 smoke 範圍內 ——
 * 端到端切片驗證見 README「端到端驗證」。
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureDataDir = join(projectRoot, 'tests/fixtures/datadir');

const workDir = await mkdtemp(join(tmpdir(), 'bambu-mcp-smoke-'));
const dataDir = join(workDir, 'datadir');
const modelDir = join(workDir, 'models');

// 複製 fixture 再用，避免 smoke 寫髒版控裡的 fixture。
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

  // ── 工具面 ───────────────────────────────────────────────────────────
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

  // ── 狀態 ─────────────────────────────────────────────────────────────
  const status = await call('bambu_get_status', {});
  assert.equal(status.structuredContent.inheritanceFlattening, true);
  assert.equal(status.structuredContent.presetCounts.process, 1, '只有 1 個可選用的 process preset');
  assert.equal(status.structuredContent.currentSelection.machine, 'Bambu Lab P1S 0.4 nozzle');
  assert.equal(status.structuredContent.slicerAvailable, false, 'smoke 刻意指向不存在的切片器');

  // ── preset 展平（本 server 的核心） ─────────────────────────────────
  const resolved = await call('bambu_resolve_preset', {
    name: '0.20mm Standard @BBL P1S',
    kind: 'process',
  });
  const settings = resolved.structuredContent.settings;

  // 葉節點只宣告 outer_wall_speed；以下全部靠展平繼承鏈才拿得到。
  assert.equal(settings.sparse_infill_density, '15%', '繼承自 fdm_process_common');
  assert.equal(settings.elefant_foot_compensation, '0.15');
  assert.equal(settings.brim_width, '5');
  // 近的一層要蓋過遠的一層。
  assert.equal(settings.wall_loops, '3', 'fdm_process_bbl_0.20 應覆蓋 fdm_process_common');
  // metadata 不得混進切片設定。
  assert.equal(settings.description, undefined);
  assert.equal(settings.setting_id, undefined);
  assert.deepEqual(resolved.structuredContent.inheritanceChain, [
    '0.20mm Standard @BBL P1S',
    'fdm_process_bbl_0.20',
    'fdm_process_common',
  ]);
  assert.equal(resolved.structuredContent.provenance.wall_loops, 'fdm_process_bbl_0.20');

  // ── preset 清單 ─────────────────────────────────────────────────────
  const presets = await call('bambu_list_presets', { kind: 'process' });
  assert.equal(presets.structuredContent.entries.length, 1, '中間層 preset 應被過濾掉');
  const withAbstract = await call('bambu_list_presets', { kind: 'process', includeAbstract: true });
  assert.equal(withAbstract.structuredContent.entries.length, 3);

  // ── 參數知識 ─────────────────────────────────────────────────────────
  const described = await call('bambu_describe_parameters', { keys: ['layer_height', '打錯的名字'] });
  assert.equal(described.structuredContent.specs.length, 1);
  assert.deepEqual(described.structuredContent.unknown, ['打錯的名字']);

  const diagnosis = await call('bambu_diagnose', { symptom: '底部一圈胖出來', material: 'PLA' });
  assert.equal(diagnosis.structuredContent.matched[0].id, 'elephant-foot');
  assert.ok(diagnosis.structuredContent.matched[0].remedies.length > 0);
  // 每個建議都要講代價。
  for (const remedy of diagnosis.structuredContent.matched[0].remedies) {
    assert.ok(remedy.cost.length > 0, `${remedy.key} 沒有說明代價`);
  }

  const noMatch = await call('bambu_diagnose', { symptom: '完全無關的敘述' });
  assert.equal(noMatch.structuredContent.matched.length, 0);
  assert.match(noMatch.structuredContent.note, /不做模糊猜測/);

  // ── 目標導向規劃 ─────────────────────────────────────────────────────
  const plan = await call('bambu_plan_settings', { goal: '不要印壞，慢慢印，怕翹起來也怕撞到', material: 'PLA' });
  assert.equal(plan.isError, false);
  assert.equal(plan.structuredContent.goal.id, 'safe');
  const concerns = new Set(plan.structuredContent.moves.map((move) => move.concern));
  assert.ok(concerns.has('adhesion') && concerns.has('collision'), '應同時涵蓋翹曲與碰撞');
  // 每一項都要講代價 —— 沒有免費的參數調整。
  for (const move of plan.structuredContent.moves) {
    assert.ok(move.cost.length > 0, `${move.key} 沒有說明代價`);
    assert.ok(['scalar', 'per-extruder', 'unknown'].includes(move.valueShape));
  }
  // 沒給模型就不該有幾何觸發的調整。
  assert.equal(plan.structuredContent.moves.filter((m) => m.triggeredBy).length, 0);
  assert.equal(plan.structuredContent.printability, undefined);

  // 給了模型才依幾何追加。
  const planWithModel = await call('bambu_plan_settings', {
    goalId: 'safe',
    modelPath: join(modelDir, 'cube.stl'),
  });
  assert.equal(planWithModel.isError, false);
  assert.ok(planWithModel.structuredContent.printability !== undefined, '給了模型應回傳可列印性');

  const noGoal = await call('bambu_plan_settings', { goal: '完全無關的敘述' });
  assert.equal(noGoal.structuredContent.goal, undefined);
  assert.match(noGoal.structuredContent.note, /不猜/);
  assert.ok(noGoal.structuredContent.available.length >= 5);

  // ── print-in-place 自動最佳化 ───────────────────────────────────────
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
  assert.equal(optimized.structuredContent.overrides.brim_type, 'no_brim', '預設必須明確關閉 Auto Brim');
  assert.ok(optimized.structuredContent.manualActions.some((action) => action.includes('Brim Ears')));

  // ── 寫入使用者 preset ───────────────────────────────────────────────
  const saved = await call('bambu_save_user_preset', {
    name: 'AI 調校 0.20 省時',
    kind: 'process',
    inherits: '0.20mm Standard @BBL P1S',
    overrides: { sparse_infill_density: '10%', layer_hieght: '0.28' },
  });
  assert.equal(saved.structuredContent.created, true);
  // 打錯的 key 必須被指出來，不能靜默寫進去讓使用者以為改到了。
  assert.ok(
    saved.structuredContent.warnings.some((warning) => warning.includes('layer_hieght')),
    '打錯的 key 應該被警告',
  );

  // 寫完之後立刻讀得到，而且真的繼承自原廠 preset。
  const userPreset = await call('bambu_resolve_preset', {
    name: 'AI 調校 0.20 省時',
    kind: 'process',
  });
  assert.equal(userPreset.structuredContent.settings.sparse_infill_density, '10%');
  assert.equal(userPreset.structuredContent.settings.wall_loops, '3', '其餘設定仍從原廠繼承');
  assert.equal(userPreset.structuredContent.origin, 'user');

  // 同名不覆寫。
  const conflict = await call('bambu_save_user_preset', {
    name: 'AI 調校 0.20 省時',
    kind: 'process',
    inherits: '0.20mm Standard @BBL P1S',
    overrides: { sparse_infill_density: '5%' },
  });
  assert.equal(conflict.isError, true, '同名 preset 不應被靜默覆蓋');

  // ── 模型 ─────────────────────────────────────────────────────────────
  const inspected = await call('bambu_inspect_model', { modelPath: join(modelDir, 'cube.stl') });
  assert.equal(inspected.structuredContent.triangleCount, 12);
  assert.equal(inspected.structuredContent.closed, true);
  assert.ok(Math.abs(inspected.structuredContent.volumeMm3 - 8000) < 0.5);

  const printability = await call('bambu_check_printability', {
    modelPath: join(modelDir, 'cube.stl'),
  });
  assert.equal(printability.structuredContent.fitsBuildVolume, true);
  // 貼床的底面不該被算成需要支撐的懸空。
  assert.equal(printability.structuredContent.overhangAreaRatio, 0);

  // 允許清單之外一律拒絕。
  const denied = await call('bambu_inspect_model', { modelPath: '/etc/passwd' });
  assert.equal(denied.isError, true);

  // ── 組裝 3MF ─────────────────────────────────────────────────────────
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
  // 沒碰到本體的零件會產生一個合法但毫無作用的檔案，必須講出來。
  assert.equal(composed.structuredContent.parts[2].intersectsBody, false);
  assert.ok(
    composed.structuredContent.warnings.some((warning) => warning.includes('far-away')),
    '不相交的零件應該被警告',
  );

  // 寫進去的東西必須讀得回來 —— 這是檔案路線相對 GUI 自動化的關鍵差別。
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
  assert.ok(parts.every((part) => part.recognised), 'subtype 必須都是 BambuStudio 認得的');

  // 拼錯的類型必須擋下來：BambuStudio 會把它靜默當成 normal_part，
  // 「挖掉一塊」就變成「加上一塊實心」。
  const badSubtype = await call('bambu_compose_model', {
    name: 'smoke-bad',
    basePath: join(modelDir, 'cube.stl'),
    parts: [{ name: 'x', subtype: 'negative-part', shape: { kind: 'box', size: { x: 1, y: 1, z: 1 } } }],
  });
  assert.equal(badSubtype.isError, true);

  // ── 搜尋 ─────────────────────────────────────────────────────────────
  const search = await call('bambu_search_models', { query: 'benchy', sources: ['makerworld'] });
  const makerworld = search.structuredContent.results[0];
  assert.equal(makerworld.integration, 'handoff-only');
  assert.equal(makerworld.hits.length, 0, '沒有官方 API 就不該假裝有結果');
  assert.match(makerworld.handoffUrl, /makerworld\.com/);

  // ── 切片在沒有執行檔時要明確失敗，不能假裝成功 ─────────────────────
  const slice = await call('bambu_slice', { modelPath: join(modelDir, 'cube.stl') });
  assert.equal(slice.isError, true);
  assert.match(slice.structuredContent.reason, /找不到 BambuStudio 執行檔|BAMBU_OUTPUT_DIR/);

  process.stdout.write('Bambu MCP stdio smoke passed.\n');
} finally {
  await client.close();
  await rm(workDir, { recursive: true, force: true });
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}

/** 產生一個法向量朝外的立方體 binary STL。 */
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
