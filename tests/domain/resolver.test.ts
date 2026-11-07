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
  type TemplateReader,
} from '../../src/domain/presets/resolver.js';

/**
 * These fixtures deliberately copy the real shape of BambuStudio system presets:
 * the leaf preset declares only a few keys, and most settings live in a common file three layers up.
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
    description: 'must not end up in the flattened result',
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
  it('overrides along the inheritance chain from root to leaf', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);

    // The leaf preset only declares outer_wall_speed itself; everything else comes from the layers above.
    expect(resolved.settings['sparse_infill_density']).toBe('15%');
    expect(resolved.settings['brim_width']).toBe('5');
    expect(resolved.settings['elefant_foot_compensation']).toBe('0.15');
    expect(resolved.settings['outer_wall_speed']).toEqual(['200', '350']);
  });

  it('a nearer layer overrides a farther one', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    // common gives 2, single_common gives 3; the nearer single_common should win.
    expect(resolved.settings['wall_loops']).toBe('3');
  });

  it('reports the inheritance chain from leaf to root', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    expect(resolved.inheritanceChain).toEqual([
      '0.20mm Standard @BBL X1C',
      'fdm_process_single_0.20',
      'fdm_process_single_common',
      'fdm_process_common',
    ]);
  });

  it('records which layer each value actually came from', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    expect(resolved.provenance['sparse_infill_density']).toBe('fdm_process_common');
    expect(resolved.provenance['wall_loops']).toBe('fdm_process_single_common');
    expect(resolved.provenance['outer_wall_speed']).toBe('0.20mm Standard @BBL X1C');
  });

  it('excludes metadata fields so they do not pollute slicing settings', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    expect(resolved.settings['description']).toBeUndefined();
    expect(resolved.settings['setting_id']).toBeUndefined();
    expect(resolved.settings['inherits']).toBeUndefined();
    expect(resolved.settings['name']).toBeUndefined();
  });

  it('throws a clear error when the preset is not found', () => {
    expect(() => resolvePreset('does-not-exist', 'process', reader)).toThrow(PresetResolutionError);
  });

  it('names the inheriting preset when a parent does not exist', () => {
    const broken = (name: string): RawPreset | undefined =>
      name === 'leaf'
        ? { name, kind: 'process', origin: 'system', body: { inherits: 'missing-parent' } }
        : undefined;
    expect(() => resolvePreset('leaf', 'process', broken)).toThrow(/leaf inherits a process preset that does not exist: missing-parent/);
  });

  it('detects inheritance cycles instead of recursing forever', () => {
    const cyclic = (name: string): RawPreset => ({
      name,
      kind: 'process',
      origin: 'system',
      body: { inherits: name === 'a' ? 'b' : 'a' },
    });
    expect(() => resolvePreset('a', 'process', cyclic)).toThrow(/inheritance cycle/);
  });
});

describe('toFlattenedPresetFile', () => {
  it('removes inherits and keeps the type the CLI uses to tell files apart', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    const file = toFlattenedPresetFile(resolved);
    expect(file['inherits']).toBeUndefined();
    expect(file['type']).toBe('process');
    expect(file['name']).toBe('0.20mm Standard @BBL X1C');
  });

  it('overrides take precedence over the flattened result', () => {
    const resolved = resolvePreset('0.20mm Standard @BBL X1C', 'process', reader);
    const file = toFlattenedPresetFile(resolved, { layer_height: '0.28' });
    expect(file['layer_height']).toBe('0.28');
    // Keys that were not overridden keep their flattened values.
    expect(file['sparse_infill_density']).toBe('15%');
  });
});

describe('normaliseValue', () => {
  it('converts numbers and booleans to BambuStudio string form', () => {
    expect(normaliseValue(0.28)).toBe('0.28');
    expect(normaliseValue(true)).toBe('1');
    expect(normaliseValue(false)).toBe('0');
    expect(normaliseValue(['200', 350])).toEqual(['200', '350']);
  });

  it('rejects values that cannot be converted safely instead of forcing them', () => {
    expect(normaliseValue({ nested: true })).toBeUndefined();
    expect(normaliseValue(null)).toBeUndefined();
    expect(normaliseValue(Number.NaN)).toBeUndefined();
  });
});

describe('valuesEqual', () => {
  it('treats a single value and a one-element array as equal', () => {
    expect(valuesEqual('200', ['200'])).toBe(true);
    expect(valuesEqual(['200'], '200')).toBe(true);
  });

  it('different lengths or contents are not equal', () => {
    expect(valuesEqual(['200', '350'], ['200'])).toBe(false);
    expect(valuesEqual('200', '350')).toBe(false);
  });
});

describe('diffPresets', () => {
  it('lists keys that differ and keys missing on one side', () => {
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
  it('classifies fields describing the preset itself as metadata', () => {
    expect(isMetadataKey('setting_id')).toBe(true);
    expect(isMetadataKey('inherits')).toBe(true);
    expect(isMetadataKey('layer_height')).toBe(false);
  });
});

describe('G-code templates', () => {
  /**
   * Follows the real shape of BambuStudio 02.07: machine G-code is not in the leaf preset body but in
   * separately registered `<preset> template <key>` entries; P2S 0.6 has no templates of its own and
   * inherits P2S 0.4, while X1C 0.6 has its own templates and also inherits X1C 0.4.
   */
  const MACHINES: Record<string, { origin?: 'user'; body: Record<string, unknown> }> = {
    fdm_machine_common: {
      body: { machine_start_gcode: 'G28 ; generic', change_filament_gcode: 'generic change', nozzle_diameter: ['0.4'] },
    },
    fdm_bbl_3dp_001_common: {
      body: { inherits: 'fdm_machine_common', layer_change_gcode: 'common layer change' },
    },
    'P2S 0.4': { body: { inherits: 'fdm_bbl_3dp_001_common', printer_model: 'Bambu Lab P2S' } },
    'P2S 0.6': { body: { inherits: 'P2S 0.4', nozzle_diameter: ['0.6'] } },
    'X1C 0.4': { body: { inherits: 'fdm_bbl_3dp_001_common' } },
    'X1C 0.6': { body: { inherits: 'X1C 0.4' } },
    'My P2S': { origin: 'user', body: { inherits: 'P2S 0.4', machine_start_gcode: 'user start' } },
  };

  const TEMPLATES: Record<string, Record<string, string>> = {
    'P2S 0.4': { machine_start_gcode: 'P2S start', layer_change_gcode: 'P2S layer change' },
    'X1C 0.4': { machine_start_gcode: 'X1C 0.4 start' },
    'X1C 0.6': { machine_start_gcode: 'X1C 0.6 start' },
  };

  const readMachine = (name: string): RawPreset | undefined => {
    const fixture = MACHINES[name];
    return fixture === undefined
      ? undefined
      : { name, kind: 'machine', origin: fixture.origin ?? 'system', body: fixture.body };
  };

  const readTemplates: TemplateReader = (owner, kind) =>
    Object.entries(TEMPLATES[owner] ?? {}).map(([key, value]) => ({
      name: `${owner} template ${key}`,
      kind,
      origin: 'system',
      body: { [key]: value },
    }));

  it('machine G-code the leaf does not declare comes from its template, not fdm_machine_common', () => {
    const resolved = resolvePreset('P2S 0.4', 'machine', readMachine, readTemplates);
    expect(resolved.settings['machine_start_gcode']).toBe('P2S start');
    expect(resolved.provenance['machine_start_gcode']).toBe('P2S 0.4 template machine_start_gcode');
    // The template overrides the same key declared by the common layer above.
    expect(resolved.settings['layer_change_gcode']).toBe('P2S layer change');
    // Keys without a template follow the inheritance chain as usual.
    expect(resolved.settings['change_filament_gcode']).toBe('generic change');
    expect(resolved.provenance['change_filament_gcode']).toBe('fdm_machine_common');
  });

  it('a child layer without its own templates keeps its parent\'s templates', () => {
    const resolved = resolvePreset('P2S 0.6', 'machine', readMachine, readTemplates);
    expect(resolved.settings['machine_start_gcode']).toBe('P2S start');
    expect(resolved.settings['nozzle_diameter']).toEqual(['0.6']);
  });

  it('a child layer\'s own templates override its parent\'s', () => {
    const resolved = resolvePreset('X1C 0.6', 'machine', readMachine, readTemplates);
    expect(resolved.settings['machine_start_gcode']).toBe('X1C 0.6 start');
    expect(resolved.provenance['machine_start_gcode']).toBe('X1C 0.6 template machine_start_gcode');
  });

  it('custom G-code in a user preset overrides the system template it inherits', () => {
    const resolved = resolvePreset('My P2S', 'machine', readMachine, readTemplates);
    expect(resolved.settings['machine_start_gcode']).toBe('user start');
    expect(resolved.provenance['machine_start_gcode']).toBe('My P2S');
  });

  it('system templates are not applied to a user layer, even with the same name', () => {
    const readUserNamedLikeSystem = (name: string): RawPreset | undefined =>
      name === 'P2S 0.4'
        ? { name, kind: 'machine', origin: 'user', body: { machine_start_gcode: 'user start' } }
        : readMachine(name);
    const resolved = resolvePreset('P2S 0.4', 'machine', readUserNamedLikeSystem, readTemplates);
    expect(resolved.settings['machine_start_gcode']).toBe('user start');
  });

  it('without a template reader, only the inheritance chain is used', () => {
    const resolved = resolvePreset('P2S 0.4', 'machine', readMachine);
    expect(resolved.settings['machine_start_gcode']).toBe('G28 ; generic');
  });
});
