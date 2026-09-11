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
 * 對真實安裝的 Bambu Studio 做端到端驗證。
 *
 * 與 `stdio-smoke.mjs` 的差別：smoke 用 fixture、任何機器都能跑；這支需要本機真的裝了
 * Bambu Studio，會實際啟動切片器並產生 3MF。因此**不納入 `pnpm verify`**，
 * 由人在有安裝的機器上手動執行。
 *
 * 它證明五件事：
 *   1. preset 繼承鏈展平後，切片結果採用的是原廠 preset 的真值而不是執行檔內建預設值
 *   2. 參數覆寫真的落到產物上（而不是被靜默忽略）
 *   3. 覆寫稽核會誠實回報沒生效的項目
 *   4. negative_part 真的改變幾何（判準：max_z_height）
 *   5. modifier_part 的參數只作用在它涵蓋的區域（判準：同層填充路徑長度的左右分布）
 *
 * 用法：
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
  console.error(`找不到 Bambu Studio 執行檔：${slicerPath}`);
  console.error('這支腳本需要真的安裝 Bambu Studio。用 --slicer 指定路徑，或改跑 pnpm smoke。');
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
  assert.equal(status.slicerAvailable, true, '切片器應可用');
  console.log(`資料目錄 ${status.dataDir}`);
  console.log(
    `可選用 preset：machine ${status.presetCounts.machine}／process ${status.presetCounts.process}／filament ${status.presetCounts.filament}`,
  );

  const machine = arg('machine', status.currentSelection.machine);
  const process_ = arg('process', status.currentSelection.process);
  const filament = arg('filament', status.currentSelection.filaments?.[0]);
  assert.ok(machine && process_ && filament, '找不到可用的 preset 組合，請用 --machine/--process/--filament 指定');
  console.log(`使用 ${machine} ／ ${process_} ／ ${filament}\n`);

  // ── 1. 展平 ───────────────────────────────────────────────────────────
  const resolved = await call('bambu_resolve_preset', { name: process_, kind: 'process' });
  console.log(`繼承鏈：${resolved.inheritanceChain.join('  <-  ')}`);
  console.log(`展平後 ${resolved.settingCount} 個設定\n`);
  assert.ok(resolved.inheritanceChain.length > 1, '原廠 process preset 應該有繼承鏈');

  // 這幾個參數全都繼承自上層，葉節點自己沒有宣告 —— 正是 CLI 會弄丟的那一類。
  const INHERITED_KEYS = [
    'sparse_infill_density',
    'top_shell_layers',
    'elefant_foot_compensation',
    'brim_width',
  ];

  // ── 2. 基準切片，並讀回實際生效的值 ───────────────────────────────────
  const baseline = await call('bambu_slice', {
    modelPath: join(workDir, 'cube.stl'),
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
    reportSettings: INHERITED_KEYS,
  });
  assert.equal(baseline.ok, true, `基準切片失敗：${baseline.reason ?? ''}`);
  console.log(
    `基準：${baseline.stats.layerCount} 層、${baseline.stats.totalEstimatedTimeSeconds}s、${baseline.stats.filamentGrams} g\n`,
  );

  // ── 核心斷言 ─────────────────────────────────────────────────────────
  // 產物實際採用的值，必須等於展平後的原廠 preset 值。
  // 若把原始 preset 直接餵給 CLI（也就是所有現有工具的做法），這些繼承來的參數
  // 會全部掉回 BambuStudio 執行檔內建的預設值 —— 那就是 BambuStudio#1704。
  console.log('繼承而來的參數 —— preset 展平值 vs 產物實際值：');
  for (const key of INHERITED_KEYS) {
    const expected = resolved.settings[key];
    const actual = baseline.appliedSettings[key];
    const same = normalise(expected) === normalise(actual);
    console.log(`  ${same ? '✓' : '✗'} ${key}: preset ${JSON.stringify(expected)} → 產物 ${JSON.stringify(actual)}`);
    assert.ok(
      same,
      `${key} 沒有沿用原廠 preset 的值（preset ${JSON.stringify(expected)}，產物 ${JSON.stringify(actual)}）。` +
        '這代表繼承展平失效了。',
    );
  }

  // ── 3. 覆寫 + 稽核 ────────────────────────────────────────────────────
  const tuned = await call('bambu_slice', {
    modelPath: join(workDir, 'cube.stl'),
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
    overrides: {
      layer_height: '0.28',
      sparse_infill_density: '10%',
      wall_loops: '4',
      layer_hieght: '0.3', // 故意打錯，驗證會被抓出來
    },
  });
  if (tuned.ok !== true) {
    console.error(`\n覆寫切片失敗：${tuned.reason}`);
    for (const line of tuned.stderrTail ?? []) console.error(`  ${line}`);
  }
  assert.equal(tuned.ok, true, `覆寫切片失敗：${tuned.reason ?? ''}`);
  console.log(
    `\n覆寫後：${tuned.stats.layerCount} 層、${tuned.stats.totalEstimatedTimeSeconds}s、層高 ${tuned.stats.layerHeight}`,
  );

  console.log('\n覆寫稽核：');
  for (const entry of tuned.overrideAudit) {
    console.log(
      `  ${entry.honoured ? '✓' : '✗'} ${entry.key}: 要求 ${JSON.stringify(entry.requested)} → 產物 ${JSON.stringify(entry.applied)}`,
    );
  }

  const byKey = Object.fromEntries(tuned.overrideAudit.map((entry) => [entry.key, entry]));
  assert.equal(byKey['layer_height'].honoured, true, 'layer_height 覆寫必須生效');
  assert.equal(byKey['sparse_infill_density'].honoured, true, 'sparse_infill_density 覆寫必須生效');
  assert.equal(byKey['wall_loops'].honoured, true, 'wall_loops 覆寫必須生效');
  assert.equal(byKey['layer_hieght'].honoured, false, '打錯的 key 必須被標為未生效');

  // 層高從 0.2 變 0.28，層數必須真的減少。
  assert.ok(
    tuned.stats.layerCount < baseline.stats.layerCount,
    `層高調高後層數應減少：${baseline.stats.layerCount} -> ${tuned.stats.layerCount}`,
  );
  assert.equal(tuned.stats.layerHeight, 0.28, 'G-code 標頭的層高必須等於要求值');

  console.log('\n警告：');
  for (const warning of tuned.warnings) console.log(`  · ${warning}`);

  // ── 4. 非破壞性零件（negative_part）────────────────────────────────────
  //
  // 這一段驗證的是：Bambu 的非破壞性編輯不需要幾何運算引擎，也不需要驅動 GUI ——
  // 它就是「多一個零件加一個 subtype 標籤」。
  //
  // 判準刻意選 max_z_height：negative 生效會把 20 mm 立方體削成 15 mm。
  // 若 subtype 被忽略而當成 normal_part，高度會變 25 mm。兩種錯法都會被抓到。
  console.log('\n── 非破壞性零件 ──');

  const composed = await call('bambu_compose_model', {
    name: 'e2e-topcut',
    basePath: join(workDir, 'cube.stl'),
    baseName: 'cube',
    parts: [
      {
        name: 'topcut',
        subtype: 'negative_part',
        shape: { kind: 'box', size: { x: 40, y: 40, z: 10 } },
        position: { x: 10, y: 10, z: 20 }, // 立方體是 0–20，這塊蓋住 15–25
      },
    ],
  });
  assert.ok(composed.outputPath, `組裝失敗：${JSON.stringify(composed)}`);
  console.log(`組出 ${composed.outputPath}（${composed.byteLength} bytes）`);
  for (const part of composed.parts) {
    console.log(`  ${part.subtype.padEnd(15)} ${part.name} — ${part.triangleCount} 面，與本體相交：${part.intersectsBody}`);
  }
  assert.equal(composed.parts[1].intersectsBody, true, '挖除體必須與本體相交才有效果');

  // 讀回檔案確認標籤真的寫進去了 —— 這是檔案路線相對 GUI 的關鍵優勢。
  const structure = await call('bambu_inspect_project', { projectPath: composed.outputPath });
  const parts = structure.objects[0].parts;
  console.log(`讀回：${parts.map((p) => `${p.name}=${p.subtype}`).join('、')}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].subtype, 'normal_part');
  assert.equal(parts[1].subtype, 'negative_part');
  assert.ok(parts.every((p) => p.recognised), '所有 subtype 都必須是 BambuStudio 認得的');

  const cut = await call('bambu_slice', {
    modelPath: composed.outputPath,
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
  });
  assert.equal(cut.ok, true, `挖除體切片失敗：${cut.reason ?? ''}`);

  console.log(`\n基準立方體：max_z ${baseline.stats.maxZHeight} mm、${baseline.stats.layerCount} 層、${baseline.stats.filamentGrams} g`);
  console.log(`挖掉頂部後：max_z ${cut.stats.maxZHeight} mm、${cut.stats.layerCount} 層、${cut.stats.filamentGrams} g`);

  // 成品高度不會剛好等於模型高度：層高除不盡時最後一層會超出一點
  // （0.16 層高、0.2 首層 → 0.2 + 124×0.16 = 20.04）。所以容許一層的公差。
  const tolerance = baseline.stats.layerHeight * 1.5;
  assert.ok(
    Math.abs(baseline.stats.maxZHeight - 20) < tolerance,
    `基準立方體應該約 20 mm 高，實際 ${baseline.stats.maxZHeight}`,
  );
  assert.ok(
    Math.abs(cut.stats.maxZHeight - 15) < tolerance,
    `negative_part 必須把高度削到約 15 mm，實際 ${cut.stats.maxZHeight}`,
  );
  assert.ok(cut.stats.filamentGrams < baseline.stats.filamentGrams, '削掉一塊之後耗材應該變少');

  // ── 5. 局部參數區（modifier_part）──────────────────────────────────────
  //
  // 挖除體改的是幾何，修飾體改的是「那一塊區域用不同參數切」。後者無法從外形看出來，
  // 所以判準改成空間性的：在同一層裡，被修飾體蓋住的那半邊，填充路徑長度必須明顯多於另一半。
  // 只看總耗材不夠 —— 那無法排除「參數被套到整個物件」這種錯法。
  console.log('\n── 局部參數區 ──');

  const modified = await call('bambu_compose_model', {
    name: 'e2e-modifier',
    basePath: join(workDir, 'cube.stl'),
    baseName: 'cube',
    parts: [
      {
        name: 'dense-half',
        subtype: 'modifier_part',
        // 立方體是 0–20；這塊只蓋住 x 0–10 那半邊。
        shape: { kind: 'box', size: { x: 10, y: 24, z: 24 } },
        position: { x: 5, y: 10, z: 10 },
        settings: { sparse_infill_density: '90%' },
      },
    ],
  });
  assert.ok(modified.outputPath, `修飾體組裝失敗：${JSON.stringify(modified)}`);

  const modifierStructure = await call('bambu_inspect_project', { projectPath: modified.outputPath });
  const modifierPart = modifierStructure.objects[0].parts[1];
  console.log(`讀回：${modifierPart.name}=${modifierPart.subtype}，設定 ${JSON.stringify(modifierPart.settings)}`);
  assert.equal(modifierPart.subtype, 'modifier_part');
  assert.equal(modifierPart.settings.sparse_infill_density, '90%', '零件層級設定必須寫進 3MF');

  const modifiedSlice = await call('bambu_slice', {
    modelPath: modified.outputPath,
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
  });
  assert.equal(modifiedSlice.ok, true, `修飾體切片失敗：${modifiedSlice.reason ?? ''}`);

  const split = measureInfillSplit(readGcodeFromProduct(modifiedSlice.outputPath), 10);
  console.log(
    `填充路徑長度：修飾側 ${split.dense.toFixed(0)} mm、另一側 ${split.sparse.toFixed(0)} mm` +
      `（比值 ${(split.dense / split.sparse).toFixed(2)}）`,
  );
  console.log(
    `耗材：基準 ${baseline.stats.filamentGrams} g → 局部加密 ${modifiedSlice.stats.filamentGrams} g`,
  );

  assert.ok(
    split.dense / split.sparse > 1.8,
    `修飾側的填充應該明顯較密，實際比值只有 ${(split.dense / split.sparse).toFixed(2)}`,
  );
  assert.ok(
    modifiedSlice.stats.filamentGrams > baseline.stats.filamentGrams,
    '局部加密後耗材應該增加',
  );

  console.log('\n✅ 真機端到端驗證通過。');
} finally {
  await client.close();
  rmSync(workDir, { recursive: true, force: true });
}

/** 比較前正規化：`"15%"` 與 `"15"`、`"0.28"` 與 `"0.280000"` 是同一件事。 */
function normalise(value) {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join(',') : String(value);
  const trimmed = text.trim().replace(/%$/, '');
  return /^-?\d*\.?\d+$/.test(trimmed) ? String(Number.parseFloat(trimmed)) : trimmed;
}

/** 從 .gcode.3mf 產物取出第一盤的 G-code。 */
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
  throw new Error('產物裡找不到 plate_1.gcode');
}

/**
 * 量出某一層裡「填充路徑長度」在左右兩半的分布。
 *
 * 用來驗證修飾體是否真的只作用在它涵蓋的區域。切分點取該層所有填充點的 x 中位，
 * 所以不必知道模型落在列印板哪個位置。
 *
 * 只算 `; FEATURE: Sparse infill` 的擠出移動 —— 牆與實心層在兩側都一樣多，
 * 混進來會把差異稀釋掉。
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
  assert.ok(best !== null, '找不到含足夠填充路徑的層');

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
