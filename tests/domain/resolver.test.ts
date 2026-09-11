import { describe, expect, it } from 'vitest';

import type { PresetKind } from '../../src/domain/contracts.js';
import {
  diffPresets,
  isMetadataKey,
  normaliseValue,
  PresetResolutionError,
  resolvePreset,
  toFlattenedPresetFile,
  valuesEqual,
  type RawPreset,
} from '../../src/domain/presets/resolver.js';

/**
 * 這組 fixture 刻意複製 BambuStudio 原廠 preset 的真實形狀：
 * 葉節點只宣告少數 key，大部分設定藏在三層之上的 common 檔。
 */
const FIXTURES: Record<string, Record<string, unknown>> = {
  fdm_process_common: {
    type: 'process',
    name: 'fdm_process_common',
    instantiation: 'false',
    layer_height: '0.2',
    sparse_infill_density: '15%',
    brim_width: '5',
    elefant_foot_compensation: '0.15',
    top_shell_layers: '5',
    wall_loops: '2',
  },
  fdm_process_single_common: {
    type: 'process',
    name: 'fdm_process_single_common',
    inherits: 'fdm_process_common',
    instantiation: 'false',
    wall_loops: '3',
  },
  'fdm_process_single_0.20': {
    type: 'process',
    name: 'fdm_process_single_0.20',
    inherits: 'fdm_process_single_common',
    instantiation: 'false',
    layer_height: '0.2',
  },
  '0.20mm Standard @BBL X1C': {
    type: 'process',
    name: '0.20mm Standard @BBL X1C',
    inherits: 'fdm_process_single_0.20',
    instantiation: 'true',
    setting_id: 'GP004',
    description: '不應該進入展平結果',
    outer_wall_speed: ['200', '350'],
  },
};

function reader(name: string, _kind: PresetKind): RawPreset | undefined {
  const body = FIXTURES[name];
  return body === undefined
    ? undefined
    : { name, kind: 'process', origin: 'system', body };
}

describe('resolvePreset', () => {
  it('沿繼承鏈由根往葉覆蓋', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);

    // 葉節點自己只宣告 outer_wall_speed，其餘全部來自上層。
    expect(resolved.settings['sparse_infill_density']).toBe('15%');
    expect(resolved.settings['brim_width']).toBe('5');
    expect(resolved.settings['elefant_foot_compensation']).toBe('0.15');
    expect(resolved.settings['outer_wall_speed']).toEqual(['200', '350']);
  });

  it('近的一層覆蓋遠的一層', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    // common 給 2，single_common 給 3；較近的 single_common 應該贏。
    expect(resolved.settings['wall_loops']).toBe('3');
  });

  it('回報繼承鏈由葉到根', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    expect(resolved.inheritanceChain).toEqual([
      '0.20mm Standard @BBL X1C',
      'fdm_process_single_0.20',
      'fdm_process_single_common',
      'fdm_process_common',
    ]);
  });

  it('記錄每個值實際來自哪一層', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    expect(resolved.provenance['sparse_infill_density']).toBe('fdm_process_common');
    expect(resolved.provenance['wall_loops']).toBe('fdm_process_single_common');
    expect(resolved.provenance['outer_wall_speed']).toBe('0.20mm Standard @BBL X1C');
  });

  it('排除 metadata 欄位，不讓它們污染切片設定', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    expect(resolved.settings['description']).toBeUndefined();
    expect(resolved.settings['setting_id']).toBeUndefined();
    expect(resolved.settings['inherits']).toBeUndefined();
    expect(resolved.settings['name']).toBeUndefined();
  });

  it('找不到 preset 時明確報錯', () => {
    expect(() => resolvePreset('不存在', 'process', reader)).toThrow(PresetResolutionError);
  });

  it('父層不存在時指出是誰繼承了它', () => {
    const broken = (name: string): RawPreset | undefined =>
      name === 'leaf'
        ? { name, kind: 'process', origin: 'system', body: { inherits: 'missing-parent' } }
        : undefined;
    expect(() => resolvePreset('leaf', 'process', broken)).toThrow(/繼承了不存在/);
  });

  it('偵測循環繼承而不是無限遞迴', () => {
    const cyclic = (name: string): RawPreset => ({
      name,
      kind: 'process',
      origin: 'system',
      body: { inherits: name === 'a' ? 'b' : 'a' },
    });
    expect(() => resolvePreset('a', 'process', cyclic)).toThrow(/循環/);
  });
});

describe('toFlattenedPresetFile', () => {
  it('移除 inherits，保留 CLI 判別用的 type', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    const file = toFlattenedPresetFile(resolved);
    expect(file['inherits']).toBeUndefined();
    expect(file['type']).toBe('process');
    expect(file['name']).toBe('0.20mm Standard @BBL X1C');
  });

  it('覆寫值蓋過展平結果', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    const file = toFlattenedPresetFile(resolved, { layer_height: '0.28' });
    expect(file['layer_height']).toBe('0.28');
    // 沒被覆寫的仍保留展平值。
    expect(file['sparse_infill_density']).toBe('15%');
  });
});

describe('normaliseValue', () => {
  it('把數字與布林轉成 BambuStudio 的字串表示', () => {
    expect(normaliseValue(0.28)).toBe('0.28');
    expect(normaliseValue(true)).toBe('1');
    expect(normaliseValue(false)).toBe('0');
    expect(normaliseValue(['200', 350])).toEqual(['200', '350']);
  });

  it('拒絕無法安全轉換的值，而不是硬塞', () => {
    expect(normaliseValue({ nested: true })).toBeUndefined();
    expect(normaliseValue(null)).toBeUndefined();
    expect(normaliseValue(Number.NaN)).toBeUndefined();
  });
});

describe('valuesEqual', () => {
  it('單值與單元素陣列視為相等', () => {
    expect(valuesEqual('200', ['200'])).toBe(true);
    expect(valuesEqual(['200'], '200')).toBe(true);
  });

  it('長度或內容不同就是不等', () => {
    expect(valuesEqual(['200', '350'], ['200'])).toBe(false);
    expect(valuesEqual('200', '350')).toBe(false);
  });
});

describe('diffPresets', () => {
  it('列出兩邊不同與單邊缺少的 key', () => {
    const differences = diffPresets(
      { layer_height: '0.2', wall_loops: '2' },
      { layer_height: '0.28', brim_width: '5' },
    );
    expect(differences).toEqual([
      { key: 'brim_width', left: undefined, right: '5' },
      { key: 'layer_height', left: '0.2', right: '0.28' },
      { key: 'wall_loops', left: '2', right: undefined },
    ]);
  });
});

describe('isMetadataKey', () => {
  it('把 preset 自身描述欄位歸為 metadata', () => {
    expect(isMetadataKey('setting_id')).toBe(true);
    expect(isMetadataKey('inherits')).toBe(true);
    expect(isMetadataKey('layer_height')).toBe(false);
  });
});
