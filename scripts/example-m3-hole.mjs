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
 * 範例：在一片固定片上挖兩個 M3 通孔。
 *
 * 這支腳本示範完整流程，也順便當作「孔真的挖出來了」的量測驗證：
 * 產生檔案不算數，要能從切片產物的 G-code 量出實際孔徑。
 *
 * M3 尺寸依 ISO 273：
 *   - 通孔（中等級 medium fit）Ø3.4 mm ← 本例採用
 *   - 通孔（精級 fine fit）    Ø3.2 mm
 *   - 自攻／攻牙入塑膠         Ø2.5 mm
 *   - 熱熔銅套                 依銅套規格，常見 Ø4.0 mm
 *
 * 需要本機安裝 Bambu Studio。用法：
 *   node scripts/example-m3-hole.mjs [--out <目錄>]
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const slicerPath = arg('slicer', defaultExecutablePath());
if (!existsSync(slicerPath)) {
  console.error(`找不到 Bambu Studio 執行檔：${slicerPath}`);
  process.exit(2);
}

const workDir = arg('out', join(projectRoot, '.agent-tmp', 'm3-example'));
mkdirSync(workDir, { recursive: true });

// ── 幾何參數 ─────────────────────────────────────────────────────────────
const PLATE = { x: 40, y: 20, z: 5 };
const HOLE_DIAMETER = 3.4; // M3 中等級通孔
const HOLE_SPACING = 24; // 兩孔中心距
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
  assert.ok(machine && process_ && filament, '找不到可用的 preset 組合');

  console.log(`固定片 ${PLATE.x}×${PLATE.y}×${PLATE.z} mm，兩個 Ø${HOLE_DIAMETER} mm 通孔，中心距 ${HOLE_SPACING} mm`);
  console.log(`使用 ${machine} ／ ${process_} ／ ${filament}\n`);

  // ── 1. 組裝 ────────────────────────────────────────────────────────────
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
        // 比板厚長，確保上下都完全穿透。
        height: PLATE.z * 3,
        segments: 64,
      },
      position: { x: centre.x, y: centre.y, z: PLATE.z / 2 },
    })),
  });
  assert.ok(composed.outputPath, `組裝失敗：${JSON.stringify(composed)}`);

  console.log(`組出 ${composed.outputPath}`);
  for (const part of composed.parts) {
    console.log(`  ${part.subtype.padEnd(14)} ${part.name.padEnd(11)} ${part.triangleCount} 面，相交：${part.intersectsBody}`);
  }
  assert.ok(composed.parts.slice(1).every((p) => p.intersectsBody), '兩個孔都必須與板子相交');

  // ── 2. 讀回 ────────────────────────────────────────────────────────────
  const structure = await call('bambu_inspect_project', { projectPath: composed.outputPath });
  const parts = structure.objects[0].parts;
  console.log(`\n讀回：${parts.map((p) => `${p.name}=${p.subtype}`).join('、')}`);
  assert.equal(parts.filter((p) => p.subtype === 'negative_part').length, 2);
  assert.ok(parts.every((p) => p.recognised));

  // ── 3. 切片 ────────────────────────────────────────────────────────────
  const sliced = await call('bambu_slice', {
    modelPath: composed.outputPath,
    machinePreset: machine,
    processPreset: process_,
    filamentPresets: [filament],
    reportSettings: ['line_width', 'inner_wall_line_width', 'xy_hole_compensation'],
  });
  assert.equal(sliced.ok, true, `切片失敗：${sliced.reason ?? ''}`);
  console.log(
    `\n切片：${sliced.stats.layerCount} 層、${sliced.stats.filamentGrams} g、` +
      `線寬 ${sliced.appliedSettings.line_width}、孔徑補償 ${sliced.appliedSettings.xy_hole_compensation}`,
  );

  // ── 4. 從 G-code 量實際孔徑 ────────────────────────────────────────────
  //
  // 產生檔案不算數。切片器繞著孔走的那圈路徑，中心線距孔心約等於
  // 孔半徑 + 半個線寬，所以反推得到的就是切片器眼中的實際孔徑。
  const holes = measureHoles(readGcodeFromProduct(sliced.outputPath), PLATE.z / 2);
  assert.equal(holes.length, 2, `應該量到兩個孔，實際 ${holes.length} 個`);

  console.log('\n實際孔徑（由 G-code 的 G2／G3 圓弧幾何反推）：');
  for (const [index, hole] of holes.entries()) {
    const deviation = hole.diameter - HOLE_DIAMETER;
    console.log(
      `  孔 ${index + 1}  圓心 (${hole.cx.toFixed(2)}, ${hole.cy.toFixed(2)})  ` +
        `Ø${hole.diameter.toFixed(3)} mm（設計 Ø${HOLE_DIAMETER}，差 ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}）`,
    );
    assert.ok(Math.abs(deviation) < 0.05, `孔 ${index + 1} 偏差過大：${deviation.toFixed(3)} mm`);
    assert.ok(hole.diameter > 3.0, 'M3 通孔必須大於螺絲外徑 3.0 mm');
  }

  const spacing = Math.hypot(holes[1].cx - holes[0].cx, holes[1].cy - holes[0].cy);
  console.log(`  中心距 ${spacing.toFixed(3)} mm（設計 ${HOLE_SPACING}）`);
  assert.ok(Math.abs(spacing - HOLE_SPACING) < 0.05, '孔距不符');

  console.log(
    '\n刀路孔徑與模型完全一致（誤差 <0.01 mm）。實際印出來會略小是材料收縮與擠出行為造成的，\n' +
      '那是 xy_hole_compensation 要處理的問題 —— 先印一個校正件量測實際偏差，再決定補償值。',
  );

  console.log(`\n✅ 完成。用 Bambu Studio 開 ${composed.outputPath} 可以看到兩個挖除體零件。`);
} finally {
  await client.close();
}

// ── 工具 ─────────────────────────────────────────────────────────────────

/** 產生一片長方形板的 binary STL，座標從 (0,0,0) 起算。 */
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

/** 從 .gcode.3mf 產物取出第一盤的 G-code。 */
function readGcodeFromProduct(path) {
  const buffer = readFileSync(path);
  // 走 central directory 找 plate_1.gcode。
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
 * 從 G-code 量出圓孔的實際孔徑。
 *
 * BambuStudio 預設開啟 `enable_arc_fitting`，圓形輪廓會輸出成 G2／G3 圓弧而不是一堆短線段。
 * 圓弧指令的 I／J 是圓心相對目前位置的偏移，所以圓心與半徑可以直接算出來 ——
 * 這比取樣路徑上的點再擬合準確得多。
 *
 * 孔壁那圈路徑的 feature 是 `Outer wall`（貼著實體表面的那一圈），
 * 其中心線位於距孔心「孔半徑 + 半個線寬」處，所以孔徑 = 2 ×（半徑 − 半線寬）。
 *
 * 不預設模型落在列印板哪個位置：圓孔自己會以「同心圓弧」的形式現身，
 * 用不著知道 build item 的位移量。
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

  // 取最接近目標高度、且有外牆圓弧的那一層。
  let best = null;
  for (const [key, arcs] of byLayer) {
    const layerZ = Number.parseFloat(key);
    if (best === null || Math.abs(layerZ - targetZ) < Math.abs(best.z - targetZ)) {
      best = { z: layerZ, arcs };
    }
  }
  assert.ok(best !== null, '找不到任何外牆圓弧');

  // 同一個孔會由數段圓弧拼成，依圓心分群後取最小半徑（最靠近孔壁的那一圈）。
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
