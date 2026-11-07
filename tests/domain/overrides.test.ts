import { describe, expect, it } from 'vitest';

import type { PresetKind, PresetRecord } from '../../src/domain/contracts.js';
import { routeOverrides } from '../../src/domain/slicing/overrides.js';

const RESOLVED: Readonly<Record<PresetKind, PresetRecord>> = {
  process: { layer_height: '0.2', sparse_infill_density: '15%', wall_loops: '2' },
  filament: { nozzle_temperature: ['220'], fan_max_speed: ['100'] },
  machine: { printer_model: 'Bambu Lab P1S' },
};

describe('routeOverrides', () => {
  it('routes each parameter to the preset it actually belongs to', () => {
    const routed = routeOverrides(
      { layer_height: '0.28', nozzle_temperature: ['230'], printer_model: 'X' },
      RESOLVED,
    );
    expect(routed.buckets.process).toEqual({ layer_height: '0.28' });
    expect(routed.buckets.filament).toEqual({ nozzle_temperature: ['230'] });
    expect(routed.buckets.machine).toEqual({ printer_model: 'X' });
    expect(routed.commandLine).toEqual([]);
  });

  it('drops unrecognised parameters instead of sending them to the CLI', () => {
    // Regression test: unknown keys used to be sent as CLI flags, and an unrecognised flag
    // makes BambuStudio fail the whole slice, so a single typo ruined the entire slice.
    const routed = routeOverrides({ layer_hieght: '0.28' }, RESOLVED);
    expect(routed.dropped).toEqual(['layer_hieght']);
    expect(routed.commandLine).toEqual([]);
    expect(routed.buckets.process).toEqual({});
    expect(routed.warnings[0]).toMatch(/is not a BambuStudio parameter name/);
  });

  it('one mistyped parameter does not affect the other, correct ones', () => {
    const routed = routeOverrides({ layer_height: '0.28', oops_typo: '1' }, RESOLVED);
    expect(routed.buckets.process).toEqual({ layer_height: '0.28' });
    expect(routed.dropped).toEqual(['oops_typo']);
  });

  it('uses the catalog to decide ownership when the preset lacks the key, still writing to the right file', () => {
    // ironing_type is a process parameter listed in the catalog. Even if the process preset
    // loaded this time happens not to have the key, it should be written into the process file
    // rather than falling back to the command line: writing the file is more reliable.
    const routed = routeOverrides({ ironing_type: 'top' }, { ...RESOLVED, process: {} });
    expect(routed.buckets.process).toEqual({ ironing_type: 'top' });
    expect(routed.commandLine).toEqual([]);
    expect(routed.dropped).toEqual([]);
  });

  it('uses the command line only for valid parameters that neither the presets nor the catalog know', () => {
    // infill_direction is a real BambuStudio parameter, but not in the curated catalog.
    const routed = routeOverrides({ infill_direction: '45' }, { ...RESOLVED, process: {} });
    expect(routed.commandLine).toEqual(['--infill-direction=45']);
    expect(routed.dropped).toEqual([]);
    expect(routed.warnings[0]).toMatch(/does not belong to any loaded preset/);
  });

  it('turns underscores into hyphens for command-line parameters', () => {
    const routed = routeOverrides({ enable_arc_fitting: '1' }, { ...RESOLVED, process: {} });
    expect(routed.commandLine).toEqual(['--enable-arc-fitting=1']);
  });

  it('joins multi-nozzle array values with commas', () => {
    const routed = routeOverrides(
      { filament_flow_ratio: ['0.98', '1.0'] },
      { ...RESOLVED, filament: {} },
    );
    expect(routed.commandLine).toEqual(['--filament-flow-ratio=0.98,1.0']);
  });

  it('produces no warnings when there are no overrides', () => {
    const routed = routeOverrides({}, RESOLVED);
    expect(routed.warnings).toEqual([]);
    expect(routed.commandLine).toEqual([]);
  });
});
