import { describe, expect, it } from 'vitest';

import type { PresetKind, PresetRecord } from '../../src/domain/contracts.js';
import { routeOverrides } from '../../src/domain/slicing/overrides.js';

const RESOLVED: Readonly<Record<PresetKind, PresetRecord>> = {
  process: { layer_height: '0.2', sparse_infill_density: '15%', wall_loops: '2' },
  filament: { nozzle_temperature: ['220'], fan_max_speed: ['100'] },
  machine: { printer_model: 'Bambu Lab P1S' },
};

describe('routeOverrides', () => {
  it('依參數實際所屬的 preset 分流', () => {
    const routed = routeOverrides(
      { layer_height: '0.28', nozzle_temperature: ['230'], printer_model: 'X' },
      RESOLVED,
    );
    expect(routed.buckets.process).toEqual({ layer_height: '0.28' });
    expect(routed.buckets.filament).toEqual({ nozzle_temperature: ['230'] });
    expect(routed.buckets.machine).toEqual({ printer_model: 'X' });
    expect(routed.commandLine).toEqual([]);
  });

  it('丟棄無法辨識的參數而不是送給 CLI', () => {
    // 回歸測試：曾經把未知 key 當成 CLI flag 送出去，
    // BambuStudio 遇到不認識的 flag 會讓整次切片失敗 —— 一個打錯字毀掉整次切片。
    const routed = routeOverrides({ layer_hieght: '0.28' }, RESOLVED);
    expect(routed.dropped).toEqual(['layer_hieght']);
    expect(routed.commandLine).toEqual([]);
    expect(routed.buckets.process).toEqual({});
    expect(routed.warnings[0]).toMatch(/不是 BambuStudio 的參數名稱/);
  });

  it('一個打錯的參數不影響其他正確的參數', () => {
    const routed = routeOverrides({ layer_height: '0.28', 手滑: '1' }, RESOLVED);
    expect(routed.buckets.process).toEqual({ layer_height: '0.28' });
    expect(routed.dropped).toEqual(['手滑']);
  });

  it('preset 沒載到時用 catalog 判斷歸屬，仍寫進正確的檔案', () => {
    // ironing_type 是 catalog 收錄的 process 參數。就算這次載入的 process preset
    // 剛好沒有這個 key，也應該寫進 process 檔而不是退回命令列 —— 寫檔比命令列可靠。
    const routed = routeOverrides({ ironing_type: 'top' }, { ...RESOLVED, process: {} });
    expect(routed.buckets.process).toEqual({ ironing_type: 'top' });
    expect(routed.commandLine).toEqual([]);
    expect(routed.dropped).toEqual([]);
  });

  it('preset 與 catalog 都不認得、但確實是有效參數時才走命令列', () => {
    // infill_direction 是真實存在的 BambuStudio 參數，但不在 catalog 精選內。
    const routed = routeOverrides({ infill_direction: '45' }, { ...RESOLVED, process: {} });
    expect(routed.commandLine).toEqual(['--infill-direction=45']);
    expect(routed.dropped).toEqual([]);
    expect(routed.warnings[0]).toMatch(/不屬於任何已載入的 preset/);
  });

  it('命令列參數的底線轉成連字號', () => {
    const routed = routeOverrides({ enable_arc_fitting: '1' }, { ...RESOLVED, process: {} });
    expect(routed.commandLine).toEqual(['--enable-arc-fitting=1']);
  });

  it('多噴頭陣列值以逗號串接', () => {
    const routed = routeOverrides(
      { filament_flow_ratio: ['0.98', '1.0'] },
      { ...RESOLVED, filament: {} },
    );
    expect(routed.commandLine).toEqual(['--filament-flow-ratio=0.98,1.0']);
  });

  it('沒有覆寫時不產生任何警告', () => {
    const routed = routeOverrides({}, RESOLVED);
    expect(routed.warnings).toEqual([]);
    expect(routed.commandLine).toEqual([]);
  });
});
