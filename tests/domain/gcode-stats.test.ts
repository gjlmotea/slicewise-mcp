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

  it('多材列印的第一個重量欄位仍可解析', () => {
    const stats = parseGcodeStats(
      [
        '; total layer number: 50',
        '; max_z_height: 10.00',
        '; layer_height = 0.2',
        '; total filament weight [g] : 12.5',
      ].join('\n'),
    );
    expect(stats?.filamentGrams).toBe(12.5);
  });
});

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
