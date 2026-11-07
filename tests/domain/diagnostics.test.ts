import { describe, expect, it } from 'vitest';

import { describeParameter, knownParameterKeys, rangeWarning } from '../../src/domain/parameters/catalog.js';
import {
  isKnownParameterKey,
  KNOWN_PARAMETER_KEYS,
  unknownParameterKeys,
} from '../../src/domain/parameters/known-keys.js';
import { getSymptom, listSymptoms, matchSymptoms } from '../../src/domain/parameters/diagnostics.js';

describe('matchSymptoms', () => {
  it('matches a Chinese description', () => {
    const matches = matchSymptoms('印出來底部一圈胖出來');
    expect(matches[0]?.symptom.id).toBe('elephant-foot');
  });

  it('matches an English description', () => {
    const matches = matchSymptoms('corners are warping off the plate');
    expect(matches[0]?.symptom.id).toBe('warping');
  });

  it('ranks symptoms with more matched keywords first', () => {
    const matches = matchSymptoms('牽絲 拉絲 到處都是毛絲');
    expect(matches[0]?.symptom.id).toBe('stringing');
    expect(matches[0]?.score).toBeGreaterThan(1);
  });

  it('knocked over mid-print: matches knocked-over, and the remedies start with an object-level brim', () => {
    // This is the verbatim description from a real case; the symptom table had no entry for it then, so nothing matched.
    const matches = matchSymptoms('印到一半，底面小、上面往外張開的碗被噴頭撞倒脫床，後面變成一團麵條');
    expect(matches[0]?.symptom.id).toBe('knocked-over');
    expect(matches[0]?.symptom.remedies[0]?.key).toBe('brim_type');
  });

  it('knocked-over does not suggest reduce_crossing_wall: in testing it increased un-lifted travel moves across walls', () => {
    const symptom = getSymptom('knocked-over');
    expect(symptom).toBeDefined();
    const keys = symptom?.remedies.map((remedy) => remedy.key) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain('reduce_crossing_wall');
  });

  it('returns an empty array when nothing matches instead of guessing fuzzily', () => {
    // Guessing the wrong symptom produces advice that makes things worse, so returning nothing is better.
    expect(matchSymptoms('這台機器的顏色不好看')).toEqual([]);
  });
});

describe('symptom table', () => {
  it('every symptom has at least one remedy', () => {
    for (const symptom of listSymptoms()) {
      expect(symptom.remedies.length).toBeGreaterThan(0);
    }
  });

  it('every remedy states its cost', () => {
    // No parameter change is free; a remedy that does not state its cost is misleading.
    for (const symptom of listSymptoms()) {
      for (const remedy of symptom.remedies) {
        expect(remedy.cost.length).toBeGreaterThan(0);
        expect(remedy.rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it('every parameter a remedy points to is in the catalog', () => {
    // List every gap at once rather than fixing them one by one; failing one at a time turns patching into whack-a-mole.
    const known = new Set(knownParameterKeys());
    const missing = listSymptoms().flatMap((symptom) =>
      symptom.remedies
        .filter((remedy) => !known.has(remedy.key))
        .map((remedy) => `${symptom.id} -> ${remedy.key}`),
    );
    expect(missing).toEqual([]);
  });

  it('ids are unique', () => {
    const ids = listSymptoms().map((symptom) => symptom.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getSymptom returns a known symptom', () => {
    expect(getSymptom('warping')?.label).toContain('Warping');
    expect(getSymptom('no-such-symptom')).toBeUndefined();
  });
});

describe('parameter catalog', () => {
  it('every parameter explains both raising and lowering it', () => {
    for (const key of knownParameterKeys()) {
      const spec = describeParameter(key);
      expect(spec?.raising.length).toBeGreaterThan(0);
      expect(spec?.lowering.length).toBeGreaterThan(0);
      expect(spec?.whatItDoes.length).toBeGreaterThan(0);
    }
  });

  it('every key in the catalog really exists in BambuStudio', () => {
    // BambuStudio silently ignores misspelled parameter names, so the catalog itself must match the real key space.
    const bogus = knownParameterKeys().filter((key) => !isKnownParameterKey(key));
    expect(bogus).toEqual([]);
  });

  it('related entries must also be real keys', () => {
    // related means "also take a look at these" and may point to parameters the catalog does not cover
    // (the catalog is a curated subset of the 568 keys), but never to names that do not exist at all.
    const bogus = knownParameterKeys().flatMap((key) =>
      (describeParameter(key)?.related ?? [])
        .filter((related) => !isKnownParameterKey(related))
        .map((related) => `${key} -> ${related}`),
    );
    expect(bogus).toEqual([]);
  });
});

describe('rangeWarning', () => {
  it('above the recommended maximum, includes the cost of raising it', () => {
    const warning = rangeWarning('layer_height', '0.5');
    expect(warning).toBeDefined();
    expect(warning).toMatch(/above the recommended maximum/);
  });

  it('below the recommended minimum, includes the cost of lowering it', () => {
    expect(rangeWarning('nozzle_temperature', '120')).toMatch(/below the recommended minimum/);
  });

  it('does not warn inside the range', () => {
    expect(rangeWarning('layer_height', '0.2')).toBeUndefined();
  });

  it('handles values with a percent sign', () => {
    expect(rangeWarning('sparse_infill_density', '15%')).toBeUndefined();
    expect(rangeWarning('sparse_infill_density', '150%')).toMatch(/above the recommended maximum/);
  });

  it('does not warn for keys outside the catalog or non-numeric values', () => {
    expect(rangeWarning('no_such_parameter', '1')).toBeUndefined();
    expect(rangeWarning('brim_type', 'auto_brim')).toBeUndefined();
  });
});

describe('known-keys baseline', () => {
  it('covers the full flattened BambuStudio key space', () => {
    expect(KNOWN_PARAMETER_KEYS.size).toBe(568);
  });

  it('catches misspelled keys', () => {
    // BambuStudio silently ignores unknown keys, so the user would think a setting changed when it did not.
    expect(isKnownParameterKey('layer_height')).toBe(true);
    expect(isKnownParameterKey('layer_hieght')).toBe(false);
    expect(unknownParameterKeys(['layer_height', 'sparse_infill_density', 'nope'])).toEqual(['nope']);
  });
});
