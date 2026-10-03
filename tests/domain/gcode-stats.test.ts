import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  parseDurationSeconds,
  parseGcodeStats,
} from '../../src/domain/slicing/gcode-stats.js';

/** 取自本機 BambuStudio 02.07.01.62 實際輸出的標頭。 */
const REAL_HEADER = [
  '; HEADER_BLOCK_START',
  '; BambuStudio 02.07.01.62',
  '; model printing time: 8m 45s; total estimated time: 9m 5s',
  '; total layer number: 100',
  '; total filament length [mm] : 1236.35',
  '; total filament volume [cm^3] : 2973.78',
  '; total filament weight [g] : 3.75',
  '; filament_density: 1.26',
  '; max_z_height: 20.00',
  '; HEADER_BLOCK_END',
  '; layer_height = 0.2',
].join('\n');

describe('parseGcodeStats', () => {
  it('解析真實標頭', () => {
    const stats = parseGcodeStats(REAL_HEADER);
    expect(stats).toBeDefined();
    expect(stats?.layerCount).toBe(100);
    expect(stats?.maxZHeight).toBe(20);
    expect(stats?.layerHeight).toBe(0.2);
    expect(stats?.filamentGrams).toBe(3.75);
    expect(stats?.filamentLengthMm).toBe(1236.35);
  });

  it('把同一行的兩個時間分開，不會加在一起', () => {
    const stats = parseGcodeStats(REAL_HEADER);
    // 8m45s = 525s，9m5s = 545s。若沒有先以分號切開會得到 1070s。
    expect(stats?.modelPrintTimeSeconds).toBe(525);
    expect(stats?.totalEstimatedTimeSeconds).toBe(545);
  });

  it('欄位名稱含方括號時仍能正確切出 key', () => {
    const stats = parseGcodeStats(REAL_HEADER);
    // `total filament length [mm] :` 的分隔符是最後那個冒號，不是方括號。
    expect(stats?.filamentLengthMm).toBe(1236.35);
  });

  it('缺少必要欄位時回傳 undefined，而不是編造預設值', () => {
    expect(parseGcodeStats('; 只有一行註解')).toBeUndefined();
    expect(parseGcodeStats('; total layer number: 100')).toBeUndefined();
  });

  it('單色不回傳逐色明細', () => {
    expect(parseGcodeStats(REAL_HEADER)?.filamentBreakdown).toBeUndefined();
  });

  it('多色列印把各色用量加總，並逐色對應到耗材槽', () => {
    // 取自一盤四色列印的真實標頭（碗＋三個鑰匙圈，用了第 2–5 槽）。
    // 只取第一個值會把整盤 43.68 g 報成 4.66 g。
    const stats = parseGcodeStats(MULTI_COLOUR_HEADER);
    expect(stats?.filamentGrams).toBe(43.68);
    expect(stats?.filamentLengthMm).toBe(14645.86);
    expect(stats?.filamentBreakdown).toEqual([
      { filament: 2, grams: 4.66, lengthMm: 1563.48 },
      { filament: 3, grams: 4.03, lengthMm: 1350.27 },
      { filament: 4, grams: 5.47, lengthMm: 1834.46 },
      { filament: 5, grams: 29.52, lengthMm: 9897.65 },
    ]);
  });

  it('槽位數量與用量對不上時不硬配槽位', () => {
    const stats = parseGcodeStats(
      [
        '; total layer number: 50',
        '; max_z_height: 10.00',
        '; layer_height = 0.2',
        '; total filament weight [g] : 1.5,2.5',
        '; filament: 1,2,3',
      ].join('\n'),
    );
    expect(stats?.filamentGrams).toBe(4);
    expect(stats?.filamentBreakdown).toEqual([{ grams: 1.5 }, { grams: 2.5 }]);
  });
});

const MULTI_COLOUR_HEADER = [
  '; HEADER_BLOCK_START',
  '; BambuStudio 02.07.01.62',
  '; model printing time: 2h 11m 6s; total estimated time: 2h 18m 8s',
  '; total layer number: 156',
  '; total filament length [mm] : 1563.48,1350.27,1834.46,9897.65',
  '; total filament volume [cm^3] : 3760.61,3247.77,4412.38,23806.65',
  '; total filament weight [g] : 4.66,4.03,5.47,29.52',
  '; model label id: 230,252,274,296',
  '; object max height: 6.00,6.00,6.00,31.20',
  '; filament_density: 1.24,1.24,1.24,1.24,1.24',
  '; filament_diameter: 1.75,1.75,1.75,1.75,1.75',
  '; max_z_height: 31.20',
  '; filament: 2,3,4,5',
  '; HEADER_BLOCK_END',
  '; layer_height = 0.2',
].join('\n');

describe('parseDurationSeconds', () => {
  it('解析時分秒組合', () => {
    expect(parseDurationSeconds('1h 2m 3s')).toBe(3723);
    expect(parseDurationSeconds('8m 45s')).toBe(525);
    expect(parseDurationSeconds('45s')).toBe(45);
  });

  it('沒有時間單位時回傳 undefined', () => {
    expect(parseDurationSeconds('未知')).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('依量級選擇單位', () => {
    expect(formatDuration(3723)).toBe('1h 2m');
    expect(formatDuration(525)).toBe('8m 45s');
    expect(formatDuration(45)).toBe('45s');
  });
});
