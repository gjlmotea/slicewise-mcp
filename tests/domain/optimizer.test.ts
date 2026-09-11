import { describe, expect, it } from 'vitest';

import { optimizePrintInPlace } from '../../src/domain/parameters/optimizer.js';

describe('print-in-place 自動最佳化', () => {
  it('依原 preset 的純量／多噴頭形狀產生可直接寫入的值', () => {
    const result = optimizePrintInPlace({
      initial_layer_speed: ['50', '50'],
      initial_layer_infill_speed: ['105', '105'],
      outer_wall_speed: ['200', '50'],
      enable_overhang_speed: ['1', '1'],
      reduce_crossing_wall: '0',
      top_surface_pattern: 'hilbertcurve',
      ironing_type: 'top',
      fuzzy_skin: 'external',
    });

    expect(result.overrides).toMatchObject({
      initial_layer_speed: ['20', '20'],
      initial_layer_infill_speed: ['30', '30'],
      outer_wall_speed: ['60', '50'],
      enable_overhang_speed: ['1', '1'],
      reduce_crossing_wall: '1',
      top_surface_pattern: 'monotonicline',
      ironing_type: 'no ironing',
      fuzzy_skin: 'none',
      brim_type: 'no_brim',
    });
  });

  it('不把原本較慢的外牆速度反向提高', () => {
    const result = optimizePrintInPlace({ outer_wall_speed: '40' });
    expect(result.overrides['outer_wall_speed']).toBe('40');
    expect(result.changes.map((change) => change.key)).not.toContain('outer_wall_speed');
  });

  it('保留既有使用者校正值', () => {
    const result = optimizePrintInPlace(
      { initial_layer_speed: '50' },
      { xy_hole_compensation: '0.05', elefant_foot_compensation: '0.25' },
    );
    expect(result.overrides['xy_hole_compensation']).toBe('0.05');
    expect(result.overrides['elefant_foot_compensation']).toBe('0.25');
  });

  it('預設不開全域 brim，只有明確要求時才加 Brim Ears', () => {
    const safe = optimizePrintInPlace({ brim_type: 'auto_brim', brim_width: '5' });
    expect(safe.overrides['brim_type']).toBe('no_brim');
    expect(safe.manualActions.join(' ')).toMatch(/手動畫|Brim Ears/);

    const withEars = optimizePrintInPlace(
      { brim_type: 'auto_brim', brim_width: '5', brim_object_gap: '0.1' },
      {},
      { includeBrimEars: true },
    );
    expect(withEars.overrides).toMatchObject({
      brim_type: 'brim_ears',
      brim_width: '5',
      brim_object_gap: '0.15',
    });
  });
});
