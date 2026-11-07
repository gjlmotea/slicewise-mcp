import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NodePresetStore } from '../../src/adapters/node-preset-store.js';

const dataDir = fileURLToPath(new URL('../fixtures/datadir', import.meta.url));
const TEMPLATE = 'Bambu Lab P1S 0.4 nozzle template machine_start_gcode';

describe('NodePresetStore: G-code templates', () => {
  const store = new NodePresetStore(dataDir);

  it('applies the template named after the preset when flattening, not the generic start G-code from fdm_machine_common', () => {
    const resolved = store.resolve('Bambu Lab P1S 0.4 nozzle', 'machine');
    expect(resolved.settings['machine_start_gcode']).toBe(';===== P1S start =====\nM104 S0');
    expect(resolved.provenance['machine_start_gcode']).toBe(TEMPLATE);
  });

  it('a child preset inherits its parent\'s template', () => {
    const resolved = store.resolve('Bambu Lab P1S 0.6 nozzle', 'machine');
    expect(resolved.settings['machine_start_gcode']).toBe(';===== P1S start =====\nM104 S0');
    expect(resolved.settings['nozzle_diameter']).toEqual(['0.6']);
  });

  it('a template carries only the key its name specifies; extra fields do not leak into the settings', () => {
    // The fixture's template file deliberately includes an extra nozzle_diameter: ["9.9"].
    expect(store.resolve('Bambu Lab P1S 0.4 nozzle', 'machine').settings['nozzle_diameter']).toEqual(['0.4']);
    const templates = store.readTemplates('Bambu Lab P1S 0.4 nozzle', 'machine');
    expect(templates.map((template) => Object.keys(template.body))).toEqual([['machine_start_gcode']]);
  });

  it('templates are not selectable presets: they are not listed and cannot be read as presets', () => {
    const names = store.list('machine').map((entry) => entry.name);
    expect(names).toContain('Bambu Lab P1S 0.6 nozzle');
    expect(names.filter((name) => name.includes(' template '))).toEqual([]);
    expect(store.readRaw(TEMPLATE, 'machine')).toBeUndefined();
  });
});
