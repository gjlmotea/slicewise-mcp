import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  parseDurationSeconds,
  parseGcodeStats,
} from '../../src/domain/slicing/gcode-stats.js';

/** Header taken from the actual output of a local BambuStudio 02.07.01.62. */
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
  it('parses a real header', () => {
    const stats = parseGcodeStats(REAL_HEADER);
    expect(stats).toBeDefined();
    expect(stats?.layerCount).toBe(100);
    expect(stats?.maxZHeight).toBe(20);
    expect(stats?.layerHeight).toBe(0.2);
    expect(stats?.filamentGrams).toBe(3.75);
    expect(stats?.filamentLengthMm).toBe(1236.35);
  });

  it('splits the two durations on one line instead of adding them together', () => {
    const stats = parseGcodeStats(REAL_HEADER);
    // 8m45s = 525s, 9m5s = 545s. Without splitting on the semicolon first you would get 1070s.
    expect(stats?.modelPrintTimeSeconds).toBe(525);
    expect(stats?.totalEstimatedTimeSeconds).toBe(545);
  });

  it('extracts the key correctly when the field name contains brackets', () => {
    const stats = parseGcodeStats(REAL_HEADER);
    // The separator in `total filament length [mm] :` is the final colon, not the bracket.
    expect(stats?.filamentLengthMm).toBe(1236.35);
  });

  it('returns undefined when required fields are missing, rather than inventing defaults', () => {
    expect(parseGcodeStats('; just a single comment line')).toBeUndefined();
    expect(parseGcodeStats('; total layer number: 100')).toBeUndefined();
  });

  it('returns no per-colour breakdown for a single colour', () => {
    expect(parseGcodeStats(REAL_HEADER)?.filamentBreakdown).toBeUndefined();
  });

  it('sums per-colour usage for multi-colour prints and maps each colour to its filament slot', () => {
    // Taken from the real header of a four-colour plate (a bowl plus three keychains, using slots 2-5).
    // Taking only the first value would report the plate's 43.68 g as 4.66 g.
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

  it('does not force slot numbers when their count does not match the usage values', () => {
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
  it('parses combinations of hours, minutes and seconds', () => {
    expect(parseDurationSeconds('1h 2m 3s')).toBe(3723);
    expect(parseDurationSeconds('8m 45s')).toBe(525);
    expect(parseDurationSeconds('45s')).toBe(45);
  });

  it('returns undefined when there is no time unit', () => {
    expect(parseDurationSeconds('unknown')).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('picks units by magnitude', () => {
    expect(formatDuration(3723)).toBe('1h 2m');
    expect(formatDuration(525)).toBe('8m 45s');
    expect(formatDuration(45)).toBe('45s');
  });
});
