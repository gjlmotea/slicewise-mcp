import { describe, expect, it } from 'vitest';

import { filamentColourArgs } from '../../src/domain/slicing/filament-colours.js';

const FIVE_GENERIC = Array.from({ length: 5 }, () => 'Generic PLA @BBL P2S');
const PROJECT_COLOURS = ['#FFFFFF', '#2B2E31', '#46B749', '#E91D2D', '#FAFAFA'];

describe('filamentColourArgs', () => {
  it('同名耗材配多色專案時，把專案顏色原樣交給 CLI，擦料塔才不會被關掉', () => {
    expect(
      filamentColourArgs({ filamentPresets: FIVE_GENERIC, projectColours: PROJECT_COLOURS, overrides: {} }),
    ).toEqual(['--filament-colour=#FFFFFF;#2B2E31;#46B749;#E91D2D;#FAFAFA']);
  });

  it('耗材 preset 名稱不同時 CLI 本來就會保留擦料塔，不介入', () => {
    expect(
      filamentColourArgs({
        filamentPresets: ['Generic PLA @BBL P2S', 'Generic PETG @BBL P2S'],
        projectColours: PROJECT_COLOURS,
        overrides: {},
      }),
    ).toEqual([]);
  });

  it('專案只有一種顏色（大小寫不同也算同色）時不介入', () => {
    expect(
      filamentColourArgs({ filamentPresets: FIVE_GENERIC, projectColours: ['#ffffff', '#FFFFFF'], overrides: {} }),
    ).toEqual([]);
  });

  it('不是 Bambu 專案、讀不到顏色時不介入', () => {
    expect(filamentColourArgs({ filamentPresets: FIVE_GENERIC, projectColours: undefined, overrides: {} })).toEqual(
      [],
    );
  });

  it('使用者自己覆寫了 filament_colour 時不介入', () => {
    expect(
      filamentColourArgs({
        filamentPresets: FIVE_GENERIC,
        projectColours: PROJECT_COLOURS,
        overrides: { filament_colour: ['#000000'] },
      }),
    ).toEqual([]);
  });
});
