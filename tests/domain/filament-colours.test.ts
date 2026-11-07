import { describe, expect, it } from 'vitest';

import { filamentColourArgs } from '../../src/domain/slicing/filament-colours.js';

const FIVE_GENERIC = Array.from({ length: 5 }, () => 'Generic PLA @BBL P2S');
const PROJECT_COLOURS = ['#FFFFFF', '#2B2E31', '#46B749', '#E91D2D', '#FAFAFA'];

describe('filamentColourArgs', () => {
  it('passes the project colours unchanged to the CLI for same-name filaments in a multi-colour project, so the prime tower is not turned off', () => {
    expect(
      filamentColourArgs({ filamentPresets: FIVE_GENERIC, projectColours: PROJECT_COLOURS, overrides: {} }),
    ).toEqual(['--filament-colour=#FFFFFF;#2B2E31;#46B749;#E91D2D;#FAFAFA']);
  });

  it('does not intervene when filament preset names differ, since the CLI keeps the prime tower anyway', () => {
    expect(
      filamentColourArgs({
        filamentPresets: ['Generic PLA @BBL P2S', 'Generic PETG @BBL P2S'],
        projectColours: PROJECT_COLOURS,
        overrides: {},
      }),
    ).toEqual([]);
  });

  it('does not intervene when the project has only one colour (case differences count as the same colour)', () => {
    expect(
      filamentColourArgs({ filamentPresets: FIVE_GENERIC, projectColours: ['#ffffff', '#FFFFFF'], overrides: {} }),
    ).toEqual([]);
  });

  it('does not intervene when it is not a Bambu project and no colours can be read', () => {
    expect(filamentColourArgs({ filamentPresets: FIVE_GENERIC, projectColours: undefined, overrides: {} })).toEqual(
      [],
    );
  });

  it('does not intervene when the user has overridden filament_colour themselves', () => {
    expect(
      filamentColourArgs({
        filamentPresets: FIVE_GENERIC,
        projectColours: PROJECT_COLOURS,
        overrides: { filament_colour: ['#000000'] },
      }),
    ).toEqual([]);
  });
});
