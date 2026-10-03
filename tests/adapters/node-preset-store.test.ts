import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NodePresetStore } from '../../src/adapters/node-preset-store.js';

const dataDir = fileURLToPath(new URL('../fixtures/datadir', import.meta.url));
const TEMPLATE = 'Bambu Lab P1S 0.4 nozzle template machine_start_gcode';

describe('NodePresetStore：G-code 模板', () => {
  const store = new NodePresetStore(dataDir);

  it('展平時套用以 preset 命名的模板，而不是 fdm_machine_common 的通用開機段', () => {
    const resolved = store.resolve('Bambu Lab P1S 0.4 nozzle', 'machine');
    expect(resolved.settings['machine_start_gcode']).toBe(';===== P1S start =====\nM104 S0');
    expect(resolved.provenance['machine_start_gcode']).toBe(TEMPLATE);
  });

  it('子層繼承父層的模板', () => {
    const resolved = store.resolve('Bambu Lab P1S 0.6 nozzle', 'machine');
    expect(resolved.settings['machine_start_gcode']).toBe(';===== P1S start =====\nM104 S0');
    expect(resolved.settings['nozzle_diameter']).toEqual(['0.6']);
  });

  it('模板只帶名稱指定的那一個 key，夾帶的其他欄位不會混進設定', () => {
    // fixture 的模板檔故意多放了 nozzle_diameter: ["9.9"]。
    expect(store.resolve('Bambu Lab P1S 0.4 nozzle', 'machine').settings['nozzle_diameter']).toEqual(['0.4']);
    const templates = store.readTemplates('Bambu Lab P1S 0.4 nozzle', 'machine');
    expect(templates.map((template) => Object.keys(template.body))).toEqual([['machine_start_gcode']]);
  });

  it('模板不是可選用的 preset：不出現在清單，也不能當 preset 讀', () => {
    const names = store.list('machine').map((entry) => entry.name);
    expect(names).toContain('Bambu Lab P1S 0.6 nozzle');
    expect(names.filter((name) => name.includes(' template '))).toEqual([]);
    expect(store.readRaw(TEMPLATE, 'machine')).toBeUndefined();
  });
});
